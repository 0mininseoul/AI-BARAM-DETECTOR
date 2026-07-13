import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713204500_expand_analysis_v2_apify_credential_slots.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 explicit Apify credential slot migration', () => {
    it('defines exactly five V2 slots and rejects null without granting the helper', () => {
        const helper = functionDefinition('analysis_v2_valid_apify_credential_slot');
        expect(helper).toContain(
            "p_slot IN ('primary', 'secondary', 'tertiary', 'quaternary', 'quinary')"
        );
        expect(helper).toContain('COALESCE(');
        expect(helper).toContain('FALSE');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)'
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.analysis_v2_valid_apify_credential_slot/
        );
    });

    it('rebinds both V2 table constraints to the shared slot validator', () => {
        expect(migration).toContain(
            'DROP CONSTRAINT analysis_v2_provider_run_credential_check'
        );
        expect(migration).toContain(
            'DROP CONSTRAINT analysis_v2_relationship_sides_credential_check'
        );
        expect(migration.match(/analysis_v2_valid_apify_credential_slot\(/g)?.length)
            .toBeGreaterThanOrEqual(7);
    });

    it('uses the shared validator in evidence, reservation, and reconciliation paths', () => {
        for (const name of [
            'analysis_v2_valid_target_evidence_source',
            'reserve_analysis_v2_provider_run',
            'reconcile_analysis_v2_provider_run_usage',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('public.analysis_v2_valid_apify_credential_slot(');
            expect(definition).not.toContain("p_credential_slot NOT IN ('primary', 'secondary')");
        }
    });

    it('retains service-role-only execution and empty search paths for privileged RPCs', () => {
        for (const name of [
            'reserve_analysis_v2_provider_run',
            'reconcile_analysis_v2_provider_run_usage',
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
