import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713205402_disable_analysis_v2_global_ai_result_cache.sql',
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

describe('analysis V2 global AI cache disable migration contract', () => {
    it('accepts only request-scoped AI result identities', () => {
        const validator = functionDefinition('analysis_v2_valid_ai_result_identity');
        expect(validator).toContain("p_identity->>'cache_scope' = 'request'");
        expect(validator).not.toContain("p_identity->>'cache_scope' IN");
        expect(validator).not.toContain("'global_ttl'");
    });

    it('deletes existing derived results and blocks every future cache write', () => {
        expect(migration).toContain('DELETE FROM public.analysis_v2_ai_global_result_cache;');
        expect(migration).toContain(
            'REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_ai_global_cache_hit('
        );
        expect(migration).toContain(
            'BEFORE INSERT OR UPDATE ON public.analysis_v2_ai_global_result_cache'
        );
        expect(functionDefinition('analysis_v2_reject_global_ai_result_cache_write'))
            .toContain("MESSAGE = 'ANALYSIS_V2_GLOBAL_AI_RESULT_CACHE_DISABLED'");
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.checkpoint_analysis_v2_ai_global_cache_hit/
        );
    });
});
