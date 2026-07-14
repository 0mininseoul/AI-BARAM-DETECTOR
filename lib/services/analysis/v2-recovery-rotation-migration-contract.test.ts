import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714045814_add_analysis_v2_recovery_rotation.sql',
        import.meta.url
    ),
    'utf8'
);

function definition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('analysis V2 durable recovery rotation migration', () => {
    it('stores and indexes one state-derived next recovery time', () => {
        expect(migration).toContain(
            'ADD COLUMN recovery_checked_at TIMESTAMP WITH TIME ZONE'
        );
        expect(migration).toContain(
            'ADD COLUMN recovery_not_before TIMESTAMP WITH TIME ZONE'
        );
        expect(migration).toContain(
            'BEFORE INSERT OR UPDATE ON public.analysis_pipeline_jobs'
        );
        expect(migration).toContain(
            'ON public.analysis_pipeline_jobs(recovery_not_before, request_id, job_key)'
        );
        expect(migration).toContain(
            "WHERE status IN ('pending', 'processing')"
        );

        const schedule = definition('analysis_v2_set_job_recovery_schedule');
        expect(schedule).toContain("NEW.status = 'pending'");
        expect(schedule).toContain("NEW.dispatch_state = 'reserved'");
        expect(schedule).toContain("NEW.updated_at + INTERVAL '2 minutes'");
        expect(schedule).toContain("NEW.status = 'processing'");
        expect(schedule).toContain('THEN NEW.lease_expires_at');
        expect(schedule).toContain('NEW.recovery_checked_at := NULL');
    });

    it('defers task-present work only under the exact current fence', () => {
        const defer = definition('defer_analysis_v2_job_recovery');

        expect(defer).toContain('p_expected_status IS NULL');
        expect(defer).toContain('job.dispatch_generation = p_dispatch_generation');
        expect(defer).toContain('job.dispatch_reservation_token = p_dispatch_token');
        expect(defer).toContain('job.status = p_expected_status');
        expect(defer).toContain(
            'job.lease_expires_at IS NOT DISTINCT FROM p_expected_lease_expires_at'
        );
        expect(defer).toContain('job.recovery_not_before <= v_now');
        expect(defer).toContain(
            "recovery_not_before = v_now + INTERVAL '5 minutes'"
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.defer_analysis_v2_job_recovery\([\s\S]*?\) TO service_role;/
        );
    });

    it('uses the indexed durable time before applying the bounded limit', () => {
        const list = definition('list_analysis_v2_dispatchable_jobs');

        expect(list).toContain('job.recovery_not_before <= pg_catalog.clock_timestamp()');
        expect(list).toContain(
            'ORDER BY job.recovery_not_before, job.request_id, job.job_key'
        );
        expect(list).toMatch(/ORDER BY[\s\S]*LIMIT p_limit;/);
        expect(list).not.toContain('CASE job.dispatch_state');
        expect(list).not.toContain('job.updated_at <=');
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.list_analysis_v2_dispatchable_jobs\(INTEGER\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
    });
});
