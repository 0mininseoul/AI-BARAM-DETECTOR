import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260719120000_add_profile_provider_canary_journal.sql',
    import.meta.url
), 'utf8');

function definition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

const serviceRpcs = [
    'load_analysis_v2_profile_provider_canary_source',
    'load_analysis_v2_profile_provider_canary_experiment',
    'load_analysis_v2_profile_provider_canary_run',
    'reserve_analysis_v2_profile_provider_canary_run',
    'checkpoint_analysis_v2_profile_provider_canary_run_started',
    'mark_analysis_v2_profile_provider_canary_run_ambiguous',
    'terminalize_analysis_v2_profile_provider_canary_run',
    'reconcile_analysis_v2_profile_provider_canary_run_usage',
    'mark_analysis_v2_profile_provider_canary_run_storage_clean',
    'begin_analysis_v2_profile_provider_canary_terminalization',
    'claim_expired_analysis_v2_profile_provider_canary_cleanup',
    'load_analysis_v2_profile_provider_canary_cleanup_inventory',
    'mark_analysis_v2_profile_provider_canary_source_storage_clean',
    'complete_analysis_v2_profile_provider_canary_cleanup',
];

describe('profile provider canary journal migration contract', () => {
    it('separates source-level experiment state from immutable repetition rows', () => {
        const tableEnd = migration.indexOf(
            'CREATE INDEX idx_analysis_v2_profile_provider_canary_expiry'
        );
        const tables = migration.slice(0, tableEnd);
        expect(migration).toContain(
            'CREATE TABLE public.analysis_v2_profile_provider_canary_experiments ('
        );
        expect(migration).toContain(
            'CREATE TABLE public.analysis_v2_profile_provider_canary_runs ('
        );
        expect(migration).toContain(
            "canary_version TEXT NOT NULL DEFAULT 'profile-fallback-replacement-canary-v1'"
        );
        expect(migration).toContain("actor_id TEXT NOT NULL DEFAULT 'apify/instagram-scraper'");
        expect(migration).toContain("actor_build TEXT NOT NULL DEFAULT '0.0.692'");
        expect(migration).toContain('input_contract_version INTEGER NOT NULL DEFAULT 1');
        expect(migration).toContain('output_contract_version INTEGER NOT NULL DEFAULT 1');
        expect(migration).toContain("credential_slot TEXT NOT NULL DEFAULT 'primary'");
        expect(migration).toContain('requested_count INTEGER NOT NULL DEFAULT 15');
        expect(migration).toContain('max_charge_usd NUMERIC(18, 12) NOT NULL DEFAULT 0.050000000000');
        for (const field of [
            'source_run_count', 'candidate_count', 'unique_candidate_count',
            'public_candidate_count', 'incomplete_candidate_count',
            'unavailable_candidate_count', 'primary_success_candidate_count',
            'critical_candidate_count',
        ]) {
            expect(migration).toContain(`${field} INTEGER NOT NULL`);
        }
        expect(migration).toContain('rep2_approval_deadline_at TIMESTAMP WITH TIME ZONE');
        expect(migration).toContain("state IN ('active', 'awaiting_repetition_2', 'terminalizing', 'experiment_terminal')");
        expect(migration).toContain("ordered_set_hmac ~ '^[0-9a-f]{64}$'");
        expect(tables).not.toMatch(
            /username|owner_email|\burl\b|payload|provider_message|raw_error|dataset_id|key_value_store_id|request_queue_id|api_token/i
        );
    });

    it('keeps tables force-RLS RPC-only and resolution database-owner-only', () => {
        for (const table of [
            'analysis_v2_profile_provider_canary_experiments',
            'analysis_v2_profile_provider_canary_runs',
        ]) {
            expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}[\\s\\S]{0,80}FROM PUBLIC, anon, authenticated, service_role`
            ));
        }
        for (const rpc of serviceRpcs) {
            expect(definition(rpc)).toContain('SECURITY DEFINER');
            expect(definition(rpc)).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([\\s\\S]*?TO service_role`
            ));
        }
        for (const ownerOnly of [
            'resolve_analysis_v2_profile_provider_canary_adopt_run',
            'resolve_analysis_v2_profile_provider_canary_no_run',
        ]) {
            expect(definition(ownerOnly)).toContain('FOR UPDATE');
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${ownerOnly}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).not.toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${ownerOnly}\\(`
            ));
        }
    });

    it('rechecks exact source lineage and eight terminal profile fallback runs', () => {
        const source = definition('load_analysis_v2_profile_provider_canary_source');
        expect(source).toContain("analysis_request.pipeline_version = 'v2'");
        expect(source).toContain("analysis_request.status = 'failed'");
        expect(source).toContain("execution_policy.mode = 'test_operation_split'");
        expect(source).toContain("execution_policy.policy_version = 'authorized-free-e2e-v1'");
        expect(source).toContain("execution_policy.target_instagram_id = '0_min._.00'");
        expect(source).toContain("execution_policy.operation_slot_map->>'profile-fallback' = provider_run.credential_slot");
        expect(source).toContain("entitlement_consumption.selected_plan_id = 'standard'");
        expect(source).toContain("preflight.status = 'consumed'");
        expect(source).toContain('preflight.pii_scrubbed_at IS NOT NULL');
        expect(source).toContain("provider_run.status = 'succeeded'");
        expect(source).toContain("provider_run.job_key ~ '^track:profiles:batch:");
        expect(source).toContain('HAVING pg_catalog.count(*) = 8');

        const reserve = definition('reserve_analysis_v2_profile_provider_canary_run');
        expect(reserve).toContain('pg_catalog.count(DISTINCT provider_run.job_key)');
        expect(reserve).toContain('pg_catalog.count(DISTINCT provider_run.run_id)');
        expect(reserve).toContain('p_candidate_count IS DISTINCT FROM 15');
        expect(reserve).toContain('p_unique_candidate_count IS DISTINCT FROM 15');
        expect(reserve).toContain('p_public_candidate_count IS DISTINCT FROM 15');
        expect(reserve).toContain('p_incomplete_candidate_count IS DISTINCT FROM 15');
        expect(reserve).toContain('p_unavailable_candidate_count IS DISTINCT FROM 0');
        expect(reserve).toContain('p_primary_success_candidate_count IS DISTINCT FROM 0');
        expect(reserve).toContain('p_critical_candidate_count IS DISTINCT FROM 3');
        expect(reserve).toContain('APP_BOUND_SOURCE_REPLAY_PROOF');
        expect(reserve).not.toMatch(/username|profile_url|raw_outcome/i);
    });

    it('atomically hands verified-no-run to cleanup with an immediately reclaimable lease', () => {
        const resolveNoRun = definition(
            'resolve_analysis_v2_profile_provider_canary_no_run'
        );
        expect(resolveNoRun).toContain(
            'v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE'
        );
        expect(resolveNoRun).toContain(
            'FROM public.analysis_v2_profile_provider_canary_experiments AS experiment'
        );
        expect(resolveNoRun.indexOf(
            'FROM public.analysis_v2_profile_provider_canary_experiments AS experiment'
        )).toBeLessThan(resolveNoRun.indexOf(
            'FROM public.analysis_v2_profile_provider_canary_runs AS canary_run'
        ));
        expect(resolveNoRun).toContain("v_experiment.state <> 'active'");
        expect(resolveNoRun).toContain("state = 'terminalizing'");
        expect(resolveNoRun).toContain("terminal_reason = 'verified_no_run'");
        expect(resolveNoRun).toContain('cleanup_claim_token = p_reservation_token');
        expect(resolveNoRun).toContain('cleanup_lease_expires_at = v_now');
        expect(resolveNoRun).toContain("v_experiment.state = 'experiment_terminal'");
        expect(resolveNoRun).not.toContain(
            'INSERT INTO public.analysis_v2_profile_provider_canary_runs'
        );
    });

    it('keeps pre-start access admission true but persists terminal access evidence as boolean', () => {
        const reserve = definition('reserve_analysis_v2_profile_provider_canary_run');
        expect(reserve).toContain('p_restricted_access_verified IS DISTINCT FROM TRUE');

        const terminalize = definition(
            'terminalize_analysis_v2_profile_provider_canary_run'
        );
        expect(terminalize).toContain('p_restricted_access_verified BOOLEAN');
        expect(terminalize).toContain(
            'v_run.restricted_access_verified IS DISTINCT FROM p_restricted_access_verified'
        );
        expect(terminalize).toContain(
            'restricted_access_verified = p_restricted_access_verified'
        );
        const identityStart = migration.indexOf(
            'CONSTRAINT analysis_v2_profile_provider_canary_run_identity_check CHECK ('
        );
        const identityEnd = migration.indexOf(
            'CONSTRAINT analysis_v2_profile_provider_canary_run_state_value_check',
            identityStart
        );
        expect(migration.slice(identityStart, identityEnd)).not.toContain(
            'restricted_access_verified = TRUE'
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.terminalize_analysis_v2_profile_provider_canary_run\([\s\S]*?INTEGER, BOOLEAN, BOOLEAN\s*\) TO service_role/
        );
    });

    it('orders cost before storage cleanup, cleanup before rep2, and HMAC clearing last', () => {
        const markRun = definition(
            'mark_analysis_v2_profile_provider_canary_run_storage_clean'
        );
        expect(markRun).toContain("v_run.cost_status IS DISTINCT FROM 'actual'");
        expect(markRun).toContain('v_run.usage_reconciled_at IS NULL');
        expect(markRun).toContain("state = 'awaiting_repetition_2'");
        expect(markRun).toContain("INTERVAL '1 hour'");
        expect(markRun).toContain('v_run.actual_usage_usd <= 0.050000000000');

        const reconcile = definition(
            'reconcile_analysis_v2_profile_provider_canary_run_usage'
        );
        expect(reconcile).toContain('p_actual_usage_usd > 1.000000000000');

        const reserve = definition('reserve_analysis_v2_profile_provider_canary_run');
        expect(reserve).toContain('v_experiment.ordered_set_hmac IS DISTINCT FROM p_ordered_set_hmac');
        expect(reserve).toContain("v_experiment.state IS DISTINCT FROM 'awaiting_repetition_2'");
        expect(reserve).toContain('v_previous.cleanup_completed_at IS NULL');

        const complete = definition('complete_analysis_v2_profile_provider_canary_cleanup');
        expect(complete).toContain("v_experiment.state IS DISTINCT FROM 'terminalizing'");
        expect(complete).toContain('ordered_set_hmac = NULL');
        expect(complete.indexOf('ordered_set_hmac = NULL')).toBeGreaterThan(
            complete.indexOf("source_request_queue_cleanup_state IS DISTINCT FROM 'verified_absent'")
        );
    });

    it('uses experiment-before-run lock order for final run cleanup and repetition-two reserve', () => {
        const markRun = definition(
            'mark_analysis_v2_profile_provider_canary_run_storage_clean'
        );
        const reserve = definition('reserve_analysis_v2_profile_provider_canary_run');
        const experimentLock =
            'FROM public.analysis_v2_profile_provider_canary_experiments AS experiment';
        const runLock = 'FROM public.analysis_v2_profile_provider_canary_runs AS canary_run';

        expect(markRun).toContain(
            'v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE'
        );
        expect(markRun).toContain(experimentLock);
        expect(markRun.indexOf(experimentLock)).toBeLessThan(markRun.indexOf(runLock));
        expect(reserve.indexOf(experimentLock)).toBeLessThan(reserve.indexOf(runLock));
    });

    it('claims expiry waits and every expired terminalizing lease without changing its reason', () => {
        const claim = definition('claim_expired_analysis_v2_profile_provider_canary_cleanup');
        expect(claim).toContain('FOR UPDATE SKIP LOCKED');
        expect(claim).toContain("experiment.state = 'awaiting_repetition_2'");
        expect(claim).toContain('experiment.rep2_approval_deadline_at <= v_now');
        expect(claim).toContain("experiment.state = 'terminalizing'");
        expect(claim).toContain('experiment.cleanup_lease_expires_at <= v_now');
        expect(claim).not.toContain(
            "experiment.terminal_reason = 'expired_waiting_for_repetition'"
        );
        expect(claim).toContain('terminal_reason = CASE');
        expect(claim).toContain('ELSE experiment.terminal_reason END');
        expect(claim).not.toContain('INSERT INTO public.analysis_v2_profile_provider_canary_runs');
    });
});
