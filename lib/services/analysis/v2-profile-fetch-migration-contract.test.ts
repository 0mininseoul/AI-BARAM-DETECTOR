import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713164030_add_analysis_v2_profile_fetch_checkpoints.sql',
        import.meta.url
    ),
    'utf8'
);
const childCaptionMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260716130000_allow_carousel_child_captions.sql',
        import.meta.url
    ),
    'utf8'
);
const repairMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260720130000_add_analysis_v2_profile_repair_attempt.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string, source = migration): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return source.slice(start, end);
}

function expectInOrder(source: string, fragments: readonly string[]): void {
    let previous = -1;
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('analysis V2 profile checkpoint migration contract', () => {
    it('keeps both staging tables RPC-only behind forced RLS', () => {
        for (const table of [
            'analysis_v2_profile_fetch_batches',
            'analysis_v2_profile_fetch_outcomes',
        ]) {
            expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(`GRANT .* ON TABLE public\\.${table}`));
        }
    });

    it('persists a complete primary set and freezes unresolved usernames atomically', () => {
        const primary = functionDefinition('checkpoint_analysis_v2_profile_primary');
        expectInOrder(primary, [
            'analysis_v2_valid_profile_outcomes(',
            "'primary'",
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'v_now := pg_catalog.clock_timestamp()',
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_job.lease_expires_at <= v_now',
            'FROM public.analysis_v2_profile_fetch_batches AS batch',
            "MESSAGE = 'ANALYSIS_V2_PROFILE_PRIMARY_CONFLICT'",
            "WHERE outcome.value->>'status' <> 'success'",
            'INSERT INTO public.analysis_v2_profile_fetch_batches',
            'INSERT INTO public.analysis_v2_profile_fetch_outcomes',
        ]);
        expect(primary).toContain("v_job.status <> 'processing'");
        expect(primary).toContain("'requested_usernames'");
        expect(primary).toContain("'outcomes'");
    });

    it('allows fallback outcomes only for the frozen ordered set and exact replay', () => {
        const fallback = functionDefinition('checkpoint_analysis_v2_profile_fallback');
        expect(fallback).not.toContain('p_requested_usernames');
        expectInOrder(fallback, [
            'FROM public.analysis_pipeline_jobs AS job',
            'v_completed_at := pg_catalog.clock_timestamp()',
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'FROM public.analysis_v2_profile_fetch_batches AS batch',
            'v_batch.frozen_unresolved_usernames',
            "'fallback'",
            'v_batch.fallback_payload_hash <> v_payload_hash',
            "MESSAGE = 'ANALYSIS_V2_PROFILE_FALLBACK_CONFLICT'",
            'INSERT INTO public.analysis_v2_profile_fetch_outcomes',
            "'fallback'",
            'SET fallback_payload_hash = v_payload_hash',
        ]);
        const validator = functionDefinition('analysis_v2_valid_profile_outcomes');
        expect(validator).toContain("p_attempt = 'fallback'");
        expect(validator).toContain("outcome.value->>'source' <> 'apify'");
        expect(validator).toContain("'timeout', 'incomplete', 'schema'");
        expect(validator).toContain(
            "outcome.value->>'username' <> p_expected_usernames[outcome.ordinal::INTEGER]"
        );
    });

    it('fences load and exact idempotent replay behind the current claim and input hash', () => {
        for (const name of [
            'checkpoint_analysis_v2_profile_primary',
            'checkpoint_analysis_v2_profile_fallback',
            'load_analysis_v2_profile_fetch_checkpoint',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('p_claim_token UUID');
            expect(definition).toContain('p_job_input_hash TEXT');
            expect(definition).toContain('v_job.input_hash IS DISTINCT FROM p_job_input_hash');
            expect(definition).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
            expect(definition).toContain('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH');
        }
        const primary = functionDefinition('checkpoint_analysis_v2_profile_primary');
        expect(primary.indexOf('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH'))
            .toBeLessThan(primary.indexOf('IF FOUND THEN'));
        const fallback = functionDefinition('checkpoint_analysis_v2_profile_fallback');
        expect(fallback.indexOf('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH'))
            .toBeLessThan(fallback.indexOf('v_batch.fallback_completed_at IS NOT NULL'));
    });

    it('stores bounded canonical media rather than arbitrary provider payloads', () => {
        const validator = functionDefinition('analysis_v2_valid_profile_snapshot');
        expect(validator).toContain("pg_catalog.jsonb_array_length(p_profile->'latestPosts') <= 8");
        expect(validator).toContain("pg_catalog.jsonb_array_length(post.value->'mediaItems') > 20");
        expect(validator).toContain("'declaredMediaCount', 'childrenComplete'");
        expect(validator).toContain("post.value->>'type' NOT IN ('image', 'video', 'carousel', 'reel')");
        expect(migration).not.toContain('raw_provider_payload');
        expect(migration).not.toContain('credential_slot');
        expect(migration).not.toContain('provider_run_id');
        expect(migration).not.toContain('run_id');
    });

    it('additively allows only bounded string captions on carousel children', () => {
        const validator = functionDefinition(
            'analysis_v2_valid_profile_snapshot',
            childCaptionMigration
        );
        expect(childCaptionMigration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
        expect(validator).toContain("SET search_path = ''");
        expect(validator).toContain(
            "'id', 'type', 'caption', 'imageUrl', 'thumbnailUrl', 'videoUrl'"
        );
        expect(validator).toContain(
            "pg_catalog.jsonb_typeof(media.value->'caption') <> 'string'"
        );
        expect(validator).toContain(
            "pg_catalog.char_length(media.value->>'caption') > 2200"
        );
        expect(childCaptionMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_valid_profile_snapshot\(JSONB\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
    });

    it('returns outcomes in request order and exposes a terminal-only purge hook', () => {
        const snapshot = functionDefinition('analysis_v2_profile_checkpoint_snapshot');
        expect(snapshot.match(/ORDER BY outcome\.ordinal/g)).toHaveLength(2);
        expect(snapshot).toContain("'frozenUnresolvedUsernames'");
        expect(snapshot).toContain("'primaryResults'");
        expect(snapshot).toContain("'fallbackResults'");

        const purge = functionDefinition('purge_analysis_v2_profile_fetch_checkpoints');
        expect(purge).toContain("analysis_request.pipeline_version = 'v2'");
        expect(purge).toContain("analysis_request.status IN ('completed', 'failed')");
        expect(purge).toContain('DELETE FROM public.analysis_v2_profile_fetch_batches');
    });

    it('grants only the four bounded public RPCs to service_role', () => {
        for (const rpc of [
            'checkpoint_analysis_v2_profile_primary',
            'checkpoint_analysis_v2_profile_fallback',
            'load_analysis_v2_profile_fetch_checkpoint',
            'purge_analysis_v2_profile_fetch_checkpoints',
        ]) {
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_profile_/g
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_profile_checkpoint_snapshot/g
        );
    });
});

describe('analysis V2 profile repair attempt migration contract', () => {
    it('widens the attempt and source domains as strict supersets', () => {
        expect(repairMigration).toContain(
            "attempt IN ('primary', 'fallback', 'repair')"
        );
        expect(repairMigration).toContain(
            "(attempt = 'primary' AND source IN ('cache', 'selfhosted'))"
        );
        expect(repairMigration).toContain(
            "OR (attempt IN ('fallback', 'repair') AND source = 'apify')"
        );
        expectInOrder(repairMigration, [
            'DROP CONSTRAINT analysis_v2_profile_outcomes_attempt_check',
            'ADD CONSTRAINT analysis_v2_profile_outcomes_attempt_check',
            'DROP CONSTRAINT analysis_v2_profile_outcomes_source_check',
            'ADD CONSTRAINT analysis_v2_profile_outcomes_source_check',
        ]);
    });

    it('adds nullable repair bookkeeping guarded by pair, hash, subset and order checks', () => {
        for (const column of [
            'ADD COLUMN repair_usernames TEXT[]',
            'ADD COLUMN repair_payload_hash VARCHAR(64)',
            'ADD COLUMN repair_completed_at TIMESTAMP WITH TIME ZONE',
        ]) {
            expect(repairMigration).toContain(column);
        }
        for (const constraint of [
            'analysis_v2_profile_batches_repair_pair_check',
            'analysis_v2_profile_batches_repair_hash_check',
            'analysis_v2_profile_batches_repair_subset_check',
            'analysis_v2_profile_batches_repair_order_check',
        ]) {
            expect(repairMigration).toContain(`ADD CONSTRAINT ${constraint}`);
        }
        expect(repairMigration).toContain(
            'repair_usernames <@ frozen_unresolved_usernames'
        );
        expect(repairMigration).toContain(
            'AND repair_completed_at >= fallback_completed_at'
        );
    });

    it('accepts the third attempt in the shared outcome validator only for apify', () => {
        const validator = functionDefinition(
            'analysis_v2_valid_profile_outcomes',
            repairMigration
        );
        expect(validator).toContain("SET search_path = ''");
        expect(validator).toContain("p_attempt IN ('primary', 'fallback', 'repair')");
        expect(validator).toContain("p_attempt IN ('fallback', 'repair')");
        expect(validator).toContain("outcome.value->>'source' <> 'apify'");
        expect(validator).toContain(
            "p_attempt = 'primary'\n                    AND outcome.value->>'source' NOT IN ('cache', 'selfhosted')"
        );
        expect(validator).not.toContain("p_attempt = 'fallback'");
    });

    it('derives the repair set server-side and never repairs unavailable usernames', () => {
        const derived = functionDefinition(
            'analysis_v2_profile_repair_username_set',
            repairMigration
        );
        expect(derived).toContain('SECURITY DEFINER');
        expect(derived).toContain("SET search_path = ''");
        expect(derived).toContain(
            'COALESCE(fallback_outcome.status, primary_outcome.status) AS status'
        );
        expect(derived).toContain('ORDER BY merged.ordinal');
        expect(derived).toContain("WHERE merged.status = 'failed'");
        expect(derived).toContain("primary_outcome.status <> 'success'");
        expect(repairMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.analysis_v2_profile_repair_username_set\(UUID, TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(repairMigration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_profile_repair_username_set/
        );
    });

    it('exposes the repair attempt through the resume snapshot', () => {
        const snapshot = functionDefinition(
            'analysis_v2_profile_checkpoint_snapshot',
            repairMigration
        );
        expect(snapshot.match(/ORDER BY outcome\.ordinal/g)).toHaveLength(3);
        expect(snapshot).toContain("'repairResults'");
        expect(snapshot).toContain("'repairUsernames'");
        expect(snapshot).toContain("'repairCapturedAt'");
        expect(snapshot).toContain("outcome.attempt = 'repair'");
    });

    it('mirrors the fallback lock order, fence and idempotency in the repair RPC', () => {
        const repair = functionDefinition(
            'checkpoint_analysis_v2_profile_repair',
            repairMigration
        );
        expect(repair).not.toContain('p_requested_usernames');
        expectInOrder(repair, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'v_completed_at := pg_catalog.clock_timestamp()',
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            "MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH'",
            'FROM public.analysis_v2_profile_fetch_batches AS batch',
            'v_job.lease_expires_at <= v_completed_at',
            'public.analysis_v2_profile_repair_username_set(p_request_id, p_job_key)',
            'v_batch.fallback_completed_at IS NULL',
            'pg_catalog.cardinality(v_repair) = 0',
            "'repair'",
            "MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY'",
            'v_batch.repair_completed_at IS NOT NULL',
            'v_batch.repair_payload_hash <> v_payload_hash',
            "MESSAGE = 'ANALYSIS_V2_PROFILE_REPAIR_CONFLICT'",
            'INSERT INTO public.analysis_v2_profile_fetch_outcomes',
            "'repair'",
            'SET repair_usernames = v_repair',
        ]);
        expect(repair.indexOf('ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH'))
            .toBeLessThan(repair.indexOf('v_batch.repair_completed_at IS NOT NULL'));
    });

    it('grants only the repair RPC to service_role', () => {
        expect(repairMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.checkpoint_analysis_v2_profile_repair\(\s*UUID, TEXT, UUID, TEXT, JSONB\s*\)\s*FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(repairMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.checkpoint_analysis_v2_profile_repair\(/
        );
        expect(repairMigration.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(1);
    });
});
