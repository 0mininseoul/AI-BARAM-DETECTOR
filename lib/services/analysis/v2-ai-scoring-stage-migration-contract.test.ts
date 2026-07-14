import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713202201_add_analysis_v2_ai_scoring_stage_state.sql',
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
    for (const fragment of fragments) {
        const index = source.indexOf(fragment, previous + 1);
        expect(index, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('analysis V2 AI/scoring stage migration contract', () => {
    it('keeps rich PII-bearing stage state RPC-only behind forced RLS', () => {
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_ai_scoring_stage_checkpoints ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_ai_scoring_stage_checkpoints FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_ai_scoring_stage_checkpoints\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_v2_ai_scoring_stage_checkpoints/
        );
    });

    it('checks the live producer fence before permitting an immutable replay', () => {
        const checkpoint = functionDefinition('checkpoint_analysis_v2_ai_scoring_stage');
        expectInOrder(checkpoint, [
            'analysis_v2_assert_result_job_fence(',
            'analysis_v2_assert_ai_scoring_stage_producer(',
            'SELECT checkpoint.* INTO v_existing',
            "MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT'",
            'INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints',
        ]);
        expect(checkpoint).toContain('v_existing.payload <> p_payload');
        expect(checkpoint).toContain('v_existing.result_hash <> v_result_hash');
        expect(checkpoint).toContain('SET producer_claim_token = p_claim_token');
        expect(checkpoint).not.toContain(
            'OR v_existing.producer_claim_token <> p_claim_token'
        );
    });

    it('fences every downstream rich-state read to an explicit consumer job', () => {
        const load = functionDefinition('load_analysis_v2_ai_scoring_stage');
        expectInOrder(load, [
            'analysis_v2_assert_result_job_fence(',
            'analysis_v2_assert_ai_scoring_stage_consumer(',
            'FROM public.analysis_v2_ai_scoring_stage_checkpoints',
        ]);
        const batches = functionDefinition('load_analysis_v2_profile_ai_stage_batches');
        expectInOrder(batches, [
            'analysis_v2_assert_result_job_fence(',
            "v_job, 'profile_ai_batch'",
            'analysis_v2_ai_scoring_stage_envelope(checkpoint)',
        ]);
        const consumers = functionDefinition('analysis_v2_assert_ai_scoring_stage_consumer');
        expect(consumers).toContain("'coordinator:join:final-score'");
        expect(consumers).toContain("'track:narratives:batch:0'");
        expect(consumers).not.toContain('coordinator:finalize');
    });

    it('allows only the exact completed profile producer scope to cross a job boundary', () => {
        const load = functionDefinition('load_analysis_v2_profile_fetch_for_consumer');
        expectInOrder(load, [
            'analysis_v2_assert_result_job_fence(',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_profile_fetch_batches AS batch',
            "v_producer.status <> 'completed'",
            'pg_catalog.cardinality(v_batch.requested_usernames)',
            "p_producer_job_key LIKE 'track:profiles:batch:%'",
            'v_producer.input_hash IS DISTINCT FROM p_expected_producer_input_hash',
            "v_consumer.job_key <> 'track:profile-ai:batch:' || v_batch_suffix",
            "p_producer_job_key = 'track:target-evidence:collect'",
            'v_batch.requested_usernames <> ARRAY[v_target_username]',
            'analysis_v2_profile_checkpoint_snapshot(',
        ]);
        expect(load).toContain('v_batch.fallback_completed_at IS NULL');
        expect(load).toContain("'coordinator:finalize'");
    });

    it('purges short-lived rich evidence only after durable terminal finalization', () => {
        const purge = functionDefinition('purge_analysis_v2_ai_scoring_stage');
        expectInOrder(purge, [
            "p_job_key <> 'coordinator:finalize'",
            'FROM public.analysis_pipeline_jobs AS job',
            "job.status = 'completed'",
            'job.completion_token = p_claim_token',
            "request.status = 'completed'",
            'DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints',
        ]);
    });

    it('grants only bounded mutating and consumer RPCs to service_role', () => {
        for (const rpc of [
            'checkpoint_analysis_v2_ai_scoring_stage',
            'load_analysis_v2_ai_scoring_stage',
            'load_analysis_v2_profile_ai_stage_batches',
            'load_analysis_v2_profile_fetch_for_consumer',
            'purge_analysis_v2_ai_scoring_stage',
        ]) {
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_assert_ai_scoring_stage_/g
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_ai_scoring_stage_envelope/g
        );
    });
});
