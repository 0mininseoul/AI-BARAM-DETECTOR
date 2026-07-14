import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713175434_add_analysis_v2_evidence_staging.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    fragments.forEach((fragment) => {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    });
}

describe('analysis V2 evidence staging migration contract', () => {
    it('keeps every PII table RPC-only behind forced RLS, including service_role', () => {
        for (const table of [
            'analysis_v2_relationship_sides',
            'analysis_v2_relationship_rows',
            'analysis_v2_relationship_manifests',
            'analysis_v2_mutual_rows',
            'analysis_v2_target_evidence_manifests',
            'analysis_target_interactors',
        ]) {
            expect(migration).toContain(
                `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
            );
            expect(migration).toContain(
                `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`
            );
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(
                `GRANT [^;]+ ON TABLE public\\.${table}`
            ));
        }
    });

    it('stores ordered unique relationship sides up to 1200 and enforces 99 percent', () => {
        const rowTable = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_v2_relationship_rows ('),
            migration.indexOf('CREATE TABLE public.analysis_v2_relationship_manifests (')
        );
        expect(rowTable).toContain('ordinal BETWEEN 1 AND 1200');
        expect(rowTable).toContain('PRIMARY KEY (request_id, job_key, side, username)');
        expect(rowTable).toContain('UNIQUE (request_id, job_key, side, ordinal)');

        const checkpoint = functionDefinition('checkpoint_analysis_v2_relationship_side');
        expect(checkpoint).toContain('v_collected_count * 100 < p_declared_count * 99');
        expect(checkpoint).toContain('v_preflight.target_followers_count');
        expect(checkpoint).toContain('v_preflight.target_following_count');
        expect(checkpoint).toContain('p_declared_count IS DISTINCT FROM (CASE p_side');
        expect(checkpoint).toContain(
            "v_request.analysis_scope_snapshot->'relationshipCapacity'->>p_side"
        );
        expect(checkpoint).toContain("MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_INCOMPLETE'");
        expect(checkpoint).toContain(
            'v_computed_hash := public.analysis_v2_relationship_rows_hash(p_side, p_rows)'
        );
        expect(checkpoint).toContain('v_computed_hash IS DISTINCT FROM p_result_hash');
        expect(checkpoint).toContain('ORDER BY relationship_row.ordinal');
    });

    it('binds exact provider and run metadata to immutable input and result hashes', () => {
        const checkpoint = functionDefinition('checkpoint_analysis_v2_relationship_side');
        expect(checkpoint).toContain('FROM public.analysis_v2_provider_runs AS provider_run');
        for (const comparison of [
            'v_provider_run.logical_provider IS DISTINCT FROM p_provider',
            'v_provider_run.input_hash IS DISTINCT FROM p_input_hash',
            'v_provider_run.run_id IS DISTINCT FROM p_provider_run_id',
            'v_provider_run.job_claim_token IS DISTINCT FROM p_claim_token',
            "v_provider_run.status <> 'succeeded'",
            'v_side.provider IS DISTINCT FROM p_provider',
            'v_side.provider_run_id IS DISTINCT FROM p_provider_run_id',
            'v_side.provider_operation_key IS DISTINCT FROM p_provider_operation_key',
            'v_side.provider_credential_slot IS DISTINCT FROM v_provider_run.credential_slot',
            'v_side.input_hash IS DISTINCT FROM p_input_hash',
            'v_side.result_hash IS DISTINCT FROM p_result_hash',
        ]) {
            expect(checkpoint).toContain(comparison);
        }
        expect(checkpoint).toContain("MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_SIDE_CONFLICT'");
        expect(checkpoint).toContain('SET job_claim_token = p_claim_token');
        expect(checkpoint).not.toContain('SET result_hash = p_result_hash');
        expect(checkpoint).not.toContain('SET input_hash = p_input_hash');
    });

    it('requires the canonical lock order and a live job claim for every mutation', () => {
        for (const name of [
            'checkpoint_analysis_v2_relationship_side',
            'freeze_analysis_v2_relationships',
            'checkpoint_analysis_v2_target_evidence',
        ]) {
            const definition = functionDefinition(name);
            expectInOrder(definition, [
                'FROM public.analysis_preflights AS preflight',
                'FROM public.analysis_requests AS analysis_request',
                'FROM public.analysis_pipeline_jobs AS job',
            ]);
            expect(definition).toContain("v_job.status <> 'processing'");
            expect(definition).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
            expect(definition).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
            expect(definition).toContain("v_job.kind <> 'collection'");
            expect(definition).toContain('v_job.batch IS NOT NULL');
            expect(definition).toContain('v_job.lease_expires_at <= v_now');
            expect(definition).toContain("MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH'");
            expect(definition.lastIndexOf('v_now := pg_catalog.clock_timestamp()'))
                .toBeGreaterThan(definition.indexOf('FROM public.analysis_pipeline_jobs AS job'));
        }
    });

    it('freezes the full intersection in following order before applying the 900 detail cap', () => {
        const freeze = functionDefinition('freeze_analysis_v2_relationships');
        expect(freeze).toContain("following_row.side = 'following'");
        expect(freeze).toContain("follower_row.side = 'followers'");
        expect(freeze).toContain(
            'following_row.username IS DISTINCT FROM v_excluded_username'
        );
        expect(freeze).toContain('ORDER BY intersected.following_ordinal');
        expect(freeze).toContain('numbered.public_ordinal <= p_detailed_mutual_limit');
        expect(freeze).toContain('v_mutual_count > 1200');
        expect(freeze).toContain('INSERT INTO public.analysis_v2_mutual_rows');

        const manifestTable = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_v2_relationship_manifests ('),
            migration.indexOf('CREATE TABLE public.analysis_v2_mutual_rows (')
        );
        expect(manifestTable).toContain('mutual_count BETWEEN 0 AND 1200');
        expect(manifestTable).toContain('detailed_mutual_limit IN (300, 600, 900)');
        expect(manifestTable).toContain(
            'detailed_public_count <= detailed_mutual_limit'
        );
    });

    it('keeps all private mutuals while marking only deterministic public detail rows', () => {
        const mutualTable = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_v2_mutual_rows ('),
            migration.indexOf('CREATE UNIQUE INDEX idx_analysis_v2_mutual_rows_detailed')
        );
        expect(mutualTable).toContain('(is_private AND detailed_ordinal IS NULL)');
        expect(mutualTable).toContain('OR NOT is_private');

        const load = functionDefinition('load_analysis_v2_relationship_staging');
        expect(load).toContain("'detailedPublicUsernames'");
        expect(load).toContain('ORDER BY mutual.detailed_ordinal');
        expect(load).toContain("'privateMutualUsernames'");
        expect(load).toContain("'privateMutualRows'");
        expect(load).toContain("'fullName', mutual.full_name");
        expect(load).toContain("'profilePicUrl', mutual.profile_pic_url");
        expect(load).toContain('AND mutual.is_private');
        expect(load).toContain('ORDER BY mutual.mutual_ordinal');
    });

    it('bounds raw target evidence to 4x150 likes plus 6x15 comments', () => {
        const validator = functionDefinition('analysis_v2_valid_target_evidence_rows');
        expect(validator).toContain('pg_catalog.jsonb_array_length(p_rows) <= 690');
        expect(validator).toContain("evidence.value->>'signal' = 'target_post_like'");
        expect(validator).toContain(') <= 4');
        expect(validator).toContain('HAVING pg_catalog.count(*) > 150');
        expect(validator).toContain("evidence.value->>'signal' = 'target_post_comment'");
        expect(validator).toContain(') <= 6');
        expect(validator).toContain('HAVING pg_catalog.count(*) > 15');
        expect(validator).toContain("evidence.value->>'actor_username' = p_target_username");
        expect(validator).toContain("evidence.value->>'actor_username' = p_excluded_username");
        expect(validator).toContain("evidence.value->>'source_interaction_id'");
    });

    it('sanitizes the storage shape and freezes target evidence by exact hash', () => {
        const table = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_target_interactors ('),
            migration.indexOf('CREATE INDEX idx_analysis_target_interactors_actor')
        );
        expect(table).toContain('comment_text VARCHAR(1000)');
        expect(table).toContain(
            'PRIMARY KEY (request_id, job_key, signal, source_interaction_id)'
        );
        expect(table).toContain('UNIQUE (request_id, job_key, ordinal)');

        const checkpoint = functionDefinition('checkpoint_analysis_v2_target_evidence');
        expect(checkpoint).toContain(
            'v_computed_hash := public.analysis_v2_target_evidence_result_hash('
        );
        expect(checkpoint).toContain(
            "public.analysis_v2_valid_target_evidence_source(\n            'target_post_like'"
        );
        expect(checkpoint).toContain('v_liker_count > COALESCE((');
        expect(checkpoint).toContain('v_comment_count > COALESCE((');
        expect(checkpoint).toContain(
            'FROM public.analysis_v2_provider_runs AS provider_run'
        );
        for (const binding of [
            'v_liker_provider_run.job_claim_token IS DISTINCT FROM p_claim_token',
            "v_liker_provider_run.input_hash IS DISTINCT FROM p_liker_source->>'input_hash'",
            "v_liker_provider_run.run_id IS DISTINCT FROM p_liker_source->>'provider_run_id'",
            'v_liker_provider_run.credential_slot IS DISTINCT FROM',
            'v_comment_provider_run.job_claim_token IS DISTINCT FROM p_claim_token',
            "v_comment_provider_run.input_hash IS DISTINCT FROM p_comment_source->>'input_hash'",
            "v_comment_provider_run.run_id IS DISTINCT FROM p_comment_source->>'provider_run_id'",
            'v_comment_provider_run.credential_slot IS DISTINCT FROM',
        ]) {
            expect(checkpoint).toContain(binding);
        }
        expect(checkpoint).toContain(
            'pg_catalog.lower(v_request.target_instagram_id) IS DISTINCT FROM p_target_username'
        );
        expect(checkpoint).toContain(
            'v_request.excluded_instagram_id IS DISTINCT FROM p_excluded_username'
        );
        expect(checkpoint).toContain("MESSAGE = 'ANALYSIS_V2_TARGET_EVIDENCE_CONFLICT'");
        expect(checkpoint).not.toContain('SET result_hash = p_result_hash');
    });

    it('returns only hashes, counts and revision to DAG-facing checkpoint calls', () => {
        const relationshipJson = functionDefinition('analysis_v2_relationship_manifest_json');
        const targetJson = functionDefinition('analysis_v2_target_evidence_manifest_json');
        expect(relationshipJson).not.toMatch(/username|comment_text|caption|postId/i);
        expect(targetJson).not.toMatch(/username|comment_text|caption|postId|content/i);
        expect(relationshipJson).toContain("'revision'");
        expect(relationshipJson).toContain("'resultHash'");
        expect(relationshipJson).toContain("'mutualCount'");
        expect(targetJson).toContain("'revision'");
        expect(targetJson).toContain("'resultHash'");
        expect(targetJson).toContain("'interactorCount'");
    });

    it('exposes only bounded SECURITY DEFINER service-role RPCs and no purge yet', () => {
        for (const rpc of [
            'checkpoint_analysis_v2_relationship_side',
            'freeze_analysis_v2_relationships',
            'load_analysis_v2_relationship_staging',
            'checkpoint_analysis_v2_target_evidence',
            'load_analysis_v2_target_evidence',
        ]) {
            const definition = functionDefinition(rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
        expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.[a-z0-9_]*purge/i);
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_provider_runs');
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_ai_attempts');
    });
});
