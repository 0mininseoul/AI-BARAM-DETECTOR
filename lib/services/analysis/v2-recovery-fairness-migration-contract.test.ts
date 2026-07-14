import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714033827_make_analysis_v2_recovery_scan_fair.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(): string {
    const start = migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.list_analysis_v2_dispatchable_jobs('
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('analysis V2 fair recovery scan migration', () => {
    it('orders every dispatch state by the time it became recoverable', () => {
        const definition = functionDefinition();

        expect(definition).toContain(
            "WHEN job.status = 'processing' THEN job.lease_expires_at"
        );
        expect(definition).toContain(
            "WHEN job.dispatch_state IN ('enqueued', 'delivered')"
        );
        expect(definition).toContain(
            "THEN job.updated_at + INTERVAL '2 minutes'"
        );
        expect(definition).toContain(
            "WHEN job.dispatch_state = 'reserved'"
        );
        expect(definition).toContain('ELSE job.created_at');
        expect(definition).toContain(
            'ORDER BY\n        job.recoverable_at,\n        job.request_id,\n        job.job_key'
        );
        expect(definition).not.toMatch(/ORDER BY[\s\S]*CASE\s+job\.dispatch_state/);
    });

    it('preserves eligibility, bounds, security, and service-role-only execution', () => {
        const definition = functionDefinition();

        expect(definition).toContain('p_limit NOT BETWEEN 1 AND 500');
        expect(definition).toContain("analysis_request.pipeline_version = 'v2'");
        expect(definition).toContain(
            "analysis_request.status IN ('pending', 'processing')"
        );
        expect(definition).toContain(
            "job.updated_at <= clock_timestamp() - INTERVAL '2 minutes'"
        );
        expect(definition).toContain(
            'job.lease_expires_at <= clock_timestamp()'
        );
        expect(definition).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.list_analysis_v2_dispatchable_jobs\(INTEGER\)\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.list_analysis_v2_dispatchable_jobs\(INTEGER\)\s+TO service_role;/
        );
    });
});
