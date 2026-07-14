import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713171647_add_analysis_v2_provider_run_ledger.sql',
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

describe('analysis V2 provider run migration contract', () => {
    it('keeps the PII-free ledger RPC-only behind forced RLS', () => {
        const tableDefinition = migration.slice(
            migration.indexOf('CREATE TABLE public.analysis_v2_provider_runs ('),
            migration.indexOf('\n);\n\nCREATE INDEX idx_analysis_v2_provider_runs_request_status')
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_provider_runs ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_provider_runs FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.analysis_v2_provider_runs\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(
            /GRANT .* ON TABLE public\.analysis_v2_provider_runs/
        );
        expect(tableDefinition).not.toMatch(
            /username|caption|comment_text|post_url|profile_url|provider_payload/i
        );
        expect(migration).toContain(
            'PRIMARY KEY (request_id, job_key, operation_key)'
        );
    });

    it('restricts operation keys to fixed kinds plus SHA-256', () => {
        const validator = functionDefinition('analysis_v2_valid_provider_operation_key');
        for (const kind of [
            'target-profile',
            'profile-fallback',
            'relationship-followers',
            'relationship-following',
            'target-likers',
            'target-comments',
            'candidate-likers',
        ]) {
            expect(validator).toContain(kind);
        }
        expect(validator).toContain(':[0-9a-f]{64}$');
        expect(migration).toContain("input_hash ~ '^[0-9a-f]{64}$'");
    });

    it('reserves only under the canonical preflight-request-job lock and a live claim', () => {
        const reserve = functionDefinition('reserve_analysis_v2_provider_run');
        expectInOrder(reserve, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_runs AS provider_run',
        ]);
        expect(reserve).toContain("v_job.status <> 'processing'");
        expect(reserve).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(reserve).toContain('v_job.lease_expires_at <= v_now');
        expect(reserve).toContain("MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH'");
    });

    it('permits only immutable identity replay while rebinding the current claim', () => {
        const reserve = functionDefinition('reserve_analysis_v2_provider_run');
        for (const comparison of [
            'v_existing.input_hash IS DISTINCT FROM p_input_hash',
            'v_existing.logical_provider IS DISTINCT FROM p_logical_provider',
            'v_existing.actor_id IS DISTINCT FROM p_actor_id',
            'v_existing.credential_slot IS DISTINCT FROM p_credential_slot',
            'v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd',
        ]) {
            expect(reserve).toContain(comparison);
        }
        expect(reserve).toContain("MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT'");
        expect(reserve).toContain('SET job_claim_token = p_claim_token');
        expect(reserve).not.toContain('SET reservation_token = p_reservation_token');
        expect(reserve).not.toContain('SET input_hash = p_input_hash');
        expect(reserve).not.toContain('SET logical_provider = p_logical_provider');
        expect(reserve).not.toContain('SET actor_id = p_actor_id');
        expect(reserve).not.toContain('SET credential_slot = p_credential_slot');
        expect(reserve).not.toContain('SET max_charge_usd = p_max_charge_usd');
        expect(reserve).toContain("'created', FALSE");
        expect(reserve).toContain("'created', TRUE");
        expectInOrder(reserve, [
            "'created', FALSE",
            'INSERT INTO public.analysis_v2_provider_runs',
            "'created', TRUE",
        ]);
    });

    it('checkpoints a run ID behind both the live claim and stable reservation fences', () => {
        const started = functionDefinition('checkpoint_analysis_v2_provider_run_started');
        expectInOrder(started, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_runs AS provider_run',
        ]);
        expect(started).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(started).toContain('v_job.lease_expires_at <= v_now');
        expect(started).toContain(
            'v_run.reservation_token IS DISTINCT FROM p_reservation_token'
        );
        expect(started).toContain('v_run.job_claim_token IS DISTINCT FROM p_claim_token');
        expect(started).toContain("SET status = 'running'");
    });

    it('terminalizes with stored fences and allows only identical replay or one usage fill', () => {
        const terminal = functionDefinition('checkpoint_analysis_v2_provider_run_terminal');
        expectInOrder(terminal, [
            'FROM public.analysis_preflights AS preflight',
            'FROM public.analysis_requests AS analysis_request',
            'FROM public.analysis_pipeline_jobs AS job',
            'FROM public.analysis_v2_provider_runs AS provider_run',
        ]);
        expect(terminal).toContain(
            'v_run.reservation_token IS DISTINCT FROM p_reservation_token'
        );
        expect(terminal).toContain('v_run.job_claim_token IS DISTINCT FROM p_claim_token');
        expect(terminal).not.toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(terminal).not.toContain('v_job.lease_expires_at <= v_now');
        expect(terminal).toContain('v_run.status IS DISTINCT FROM p_status');
        expect(terminal).toContain(
            'v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd'
        );
        expect(terminal).toContain(
            'p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL'
        );
        expect(terminal).toContain("MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_TERMINAL_CONFLICT'");
    });

    it('lists only bounded settled terminal rows that still need usage reconciliation', () => {
        const list = functionDefinition('list_analysis_v2_unreconciled_provider_runs');
        expect(list).toContain('p_limit NOT BETWEEN 1 AND 64');
        expect(list).toContain("provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')");
        expect(list).toContain('provider_run.actual_usage_usd IS NULL');
        expect(list).toContain('provider_run.usage_reconciled_at IS NULL');
        expect(list).toContain("pg_catalog.clock_timestamp() - INTERVAL '30 seconds'");
        expect(list).toContain('LIMIT p_limit');
        expect(list).toContain("'reservationToken', candidate.reservation_token");
        expect(list).toContain("'credentialSlot', candidate.credential_slot");
        expect(list).not.toContain('job_claim_token');
        expect(list).not.toContain('lease_token');
    });

    it('reconciles null usage once without a live job claim and rejects drift', () => {
        const reconcile = functionDefinition('reconcile_analysis_v2_provider_run_usage');
        expect(reconcile).toContain(
            'WHERE provider_run.reservation_token = p_reservation_token'
        );
        expect(reconcile).toContain('v_run.run_id IS DISTINCT FROM p_run_id');
        expect(reconcile).toContain(
            'v_run.logical_provider IS DISTINCT FROM p_logical_provider'
        );
        expect(reconcile).toContain('v_run.actor_id IS DISTINCT FROM p_actor_id');
        expect(reconcile).toContain(
            'v_run.credential_slot IS DISTINCT FROM p_credential_slot'
        );
        expect(reconcile).toContain(
            'v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd'
        );
        expect(reconcile).toContain('v_run.status IS DISTINCT FROM p_status');
        expect(reconcile).toContain(
            'v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd'
        );
        expect(reconcile).toContain('SET actual_usage_usd = p_actual_usage_usd');
        expect(reconcile).toContain('usage_reconciled_at = v_now');
        expect(reconcile).toContain(
            "MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT'"
        );
        expect(reconcile).not.toContain('job_claim_token');
        expect(reconcile).not.toContain('lease_token');
        expect(reconcile).not.toContain('analysis_pipeline_jobs');
    });

    it('exposes only bounded service-role RPCs and preserves the PII-free cost ledger', () => {
        for (const rpc of [
            'reserve_analysis_v2_provider_run',
            'checkpoint_analysis_v2_provider_run_started',
            'checkpoint_analysis_v2_provider_run_terminal',
            'load_analysis_v2_provider_run',
            'list_analysis_v2_unreconciled_provider_runs',
            'reconcile_analysis_v2_provider_run_usage',
        ]) {
            const definition = functionDefinition(rpc);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`
            ));
        }
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_provider_operation_key/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_provider_run_json/
        );
        expect(migration).not.toContain('purge_analysis_v2_provider_runs');
        expect(migration).not.toContain('DELETE FROM public.analysis_v2_provider_runs');
    });
});
