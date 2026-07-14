import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713211500_fix_analysis_v2_preflight_claim_return_types.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 runtime RPC corrections', () => {
    it('casts every VARCHAR preflight value returned through the TEXT RPC contract', () => {
        const definition = functionDefinition('claim_analysis_v2_preflight');

        expect(definition.match(/v_preflight\.target_instagram_id::TEXT/g)).toHaveLength(2);
        expect(definition.match(/v_preflight\.access_mode::TEXT/g)).toHaveLength(6);
        expect(definition.match(/v_preflight\.pricing_version::TEXT/g)).toHaveLength(6);
        expect(definition).toContain('v_preflight.status::TEXT');
        expect(definition).not.toMatch(
            /SELECT[\s\S]*v_preflight\.target_instagram_id,(?!::TEXT)/
        );
    });

    it('targets the job primary-key constraint without colliding with output parameters', () => {
        const definition = functionDefinition('consume_analysis_v2_test_entitlement');

        expect(definition).toContain(
            'ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING'
        );
        expect(definition).not.toContain('ON CONFLICT (request_id, job_key)');
    });

    it('keeps corrected privileged RPCs service-role only with empty search paths', () => {
        for (const name of [
            'claim_analysis_v2_preflight',
            'consume_analysis_v2_test_entitlement',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role;`
            ));
        }
    });
});
