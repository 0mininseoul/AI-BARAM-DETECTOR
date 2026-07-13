import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713214500_fix_analysis_v2_task_name_regex.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 task-name regex correction', () => {
    it('keeps the 512-character bound outside the PostgreSQL ARE expression', () => {
        expect(migration.match(/char_length\([^)]*task_name\) (?:NOT )?BETWEEN 1 AND 512/g))
            .toHaveLength(2);
        expect(migration.match(/\^\[A-Za-z0-9\]\[A-Za-z0-9\._:\/=\-\]\*\$/g))
            .toHaveLength(2);
        expect(migration).not.toMatch(
            /\^\[A-Za-z0-9\]\[A-Za-z0-9\._:\/=\-\]\{\d+,\d+\}\$/
        );
    });

    it('rebinds both the table constraint and the privileged dispatch RPC', () => {
        expect(migration).toContain(
            'DROP CONSTRAINT analysis_pipeline_jobs_task_name_check'
        );
        const definition = functionDefinition('mark_analysis_v2_job_dispatched');
        expect(definition).toContain('SECURITY DEFINER');
        expect(definition).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.mark_analysis_v2_job_dispatched\([\s\S]*?TO service_role;/
        );
    });
});
