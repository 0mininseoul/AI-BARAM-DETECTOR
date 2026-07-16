import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase/migrations');
const migrationFileName = '20260716130001_add_selfhosted_profile_global_gate.sql';
const migration = readFileSync(join(
    migrationsDirectory,
    migrationFileName
), 'utf8');

function tableDefinition(): string {
    const match = migration.match(
        /CREATE TABLE public\.selfhosted_profile_request_start_gate \([\s\S]*?\n\);/
    );
    if (!match) throw new Error('Missing selfhosted profile request-start gate table');
    return match[0];
}

function functionDefinition(): string {
    const match = migration.match(
        /CREATE OR REPLACE FUNCTION public\.reserve_selfhosted_profile_request_start\([\s\S]*?\n\$\$;/
    );
    if (!match) throw new Error('Missing selfhosted profile request-start reservation RPC');
    return match[0];
}

describe('selfhosted profile global request-start gate migration', () => {
    it('sorts strictly after the latest migration already deployed remotely', () => {
        const migrationNames = readdirSync(migrationsDirectory).sort();
        const latestRemoteMigration = '20260716130000_allow_carousel_child_captions.sql';

        expect(migrationNames).toContain(latestRemoteMigration);
        expect(migrationNames.indexOf(migrationFileName)).toBeGreaterThan(
            migrationNames.indexOf(latestRemoteMigration)
        );
    });

    it('creates and seeds exactly one PII-free constrained singleton row', () => {
        const table = tableDefinition();
        expect(table).toMatch(
            /singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK \(singleton\)/
        );
        expect(table).toMatch(/next_start_at TIMESTAMP WITH TIME ZONE NOT NULL/);
        expect(table).not.toMatch(
            /request_id|user_id|profile_id|username|instagram|email|token|payload|metadata/i
        );

        const inserts = migration.match(
            /INSERT INTO public\.selfhosted_profile_request_start_gate/g
        ) ?? [];
        expect(inserts).toHaveLength(1);
        expect(migration).toMatch(
            /INSERT INTO public\.selfhosted_profile_request_start_gate \(singleton, next_start_at\)\s+VALUES \(TRUE, pg_catalog\.clock_timestamp\(\)\);/
        );
    });

    it('forces RLS and revokes direct table access from every API role', () => {
        expect(migration).toContain(
            'ALTER TABLE public.selfhosted_profile_request_start_gate ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'ALTER TABLE public.selfhosted_profile_request_start_gate FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.selfhosted_profile_request_start_gate\s+FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)[\s\S]*?ON TABLE public\.selfhosted_profile_request_start_gate/i
        );
        expect(migration).not.toMatch(/CREATE POLICY/i);
    });

    it('uses a service-role-only SECURITY DEFINER RPC with an empty search path', () => {
        const definition = functionDefinition();
        expect(definition).toContain('RETURNS JSONB');
        expect(definition).toContain('LANGUAGE plpgsql');
        expect(definition).toContain('SECURITY DEFINER');
        expect(definition).toContain("SET search_path = ''");

        const revoke = migration.indexOf(
            'REVOKE ALL ON FUNCTION public.reserve_selfhosted_profile_request_start(INTEGER, INTEGER, INTEGER)'
        );
        const grant = migration.indexOf(
            'GRANT EXECUTE ON FUNCTION public.reserve_selfhosted_profile_request_start(INTEGER, INTEGER, INTEGER)'
        );
        expect(revoke).toBeGreaterThan(-1);
        expect(grant).toBeGreaterThan(revoke);
        expect(migration.slice(revoke, grant)).toMatch(
            /FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration.slice(grant)).toMatch(/TO service_role;/);
    });

    it('validates timing inputs and locks before a guarded atomic timestamp advance', () => {
        const definition = functionDefinition();
        expect(definition).toMatch(
            /p_min_interval_ms IS NULL\s+OR p_min_interval_ms NOT BETWEEN 250 AND 60000/
        );
        expect(definition).toMatch(
            /p_response_guard_ms IS NULL\s+OR p_response_guard_ms NOT BETWEEN 50 AND 1000/
        );
        expect(definition).toMatch(
            /p_max_wait_ms IS NULL\s+OR p_max_wait_ms NOT BETWEEN 0 AND 300000/
        );
        expect(definition).toMatch(
            /FROM public\.selfhosted_profile_request_start_gate AS gate[\s\S]*?WHERE gate\.singleton IS TRUE[\s\S]*?FOR UPDATE;/
        );
        expect(definition).toContain('v_now := pg_catalog.clock_timestamp();');
        expect(definition).toContain(
            'v_reserved_at := GREATEST(v_now, v_next_start_at);'
        );
        expect(definition).toMatch(
            /UPDATE public\.selfhosted_profile_request_start_gate AS gate[\s\S]*?SET next_start_at = v_reserved_at \+ pg_catalog\.make_interval\([\s\S]*?\(p_min_interval_ms \+ p_response_guard_ms\)::DOUBLE PRECISION \/ 1000\.0[\s\S]*?WHERE gate\.singleton IS TRUE/
        );
        const maxWaitCheck = definition.indexOf('IF v_wait_ms > p_max_wait_ms THEN');
        const update = definition.indexOf(
            'UPDATE public.selfhosted_profile_request_start_gate AS gate'
        );
        expect(maxWaitCheck).toBeGreaterThan(-1);
        expect(maxWaitCheck).toBeLessThan(update);
        expect(definition).not.toMatch(/pg_sleep/i);
    });

    it('fails closed on corrupt state and returns only a bounded strict reservation envelope', () => {
        const definition = functionDefinition();
        expect(definition).toContain('NOT pg_catalog.isfinite(v_next_start_at)');
        expect(definition).toMatch(/IF NOT FOUND THEN[\s\S]*?RAISE EXCEPTION/);
        expect(definition).toMatch(
            /v_wait_ms < 0 OR v_wait_ms > 300000/
        );
        expect(definition).toMatch(
            /pg_catalog\.jsonb_build_object\(\s*'schemaVersion', 1,\s*'waitMs', v_wait_ms,\s*'reservedAt', v_reserved_at\s*\)/
        );
        expect(definition).not.toMatch(
            /request_id|user_id|profile_id|username|instagram|email|token|payload|metadata/i
        );
    });
});
