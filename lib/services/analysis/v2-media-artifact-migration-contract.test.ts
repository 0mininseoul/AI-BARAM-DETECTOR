import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260713180254_add_analysis_v2_media_artifacts.sql'
), 'utf8');

function functionDefinition(name: string): string {
    const match = migration.match(new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
    ));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

describe('analysis V2 media artifact migration contract', () => {
    it('keeps media references RPC-only under forced RLS', () => {
        expect(migration).toContain(
            'ALTER TABLE public.analysis_v2_media_artifacts FORCE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.analysis_v2_media_artifacts\n    FROM PUBLIC, anon, authenticated, service_role'
        );
        expect(migration).not.toMatch(
            /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}analysis_v2_media_artifacts/i
        );
    });

    it('fences registration and loading by the exact live job lease', () => {
        expect(migration).toContain("v_job.status <> 'processing'");
        expect(migration).toContain('v_job.lease_token IS DISTINCT FROM p_claim_token');
        expect(migration).toContain('v_job.lease_expires_at <= v_now');
        expect(migration).toContain('job.lease_token = p_claim_token');
        expect(migration).toContain('job.lease_expires_at > pg_catalog.clock_timestamp()');
        expect(migration).toContain('ANALYSIS_V2_MEDIA_ARTIFACT_FENCE_MISMATCH');
    });

    it('stores only opaque identity and immutable object generation metadata', () => {
        const tableDefinition = migration.match(
            /CREATE TABLE public\.analysis_v2_media_artifacts \(([\s\S]*?)\n\);/
        )?.[1];
        expect(tableDefinition).toBeDefined();
        expect(migration).toContain('artifact_key VARCHAR(64) NOT NULL');
        expect(migration).toContain('artifact_kind VARCHAR(16) NOT NULL');
        expect(migration).toContain('content_sha256 VARCHAR(64) NOT NULL');
        expect(migration).toContain('content_type VARCHAR(32) NOT NULL');
        expect(migration).toContain('object_generation VARCHAR(32) NOT NULL');
        expect(migration).toContain("artifact_kind = 'media_bundle'");
        expect(migration).toContain("content_type = 'application/octet-stream'");
        expect(migration).toContain('byte_size BETWEEN 16 AND 33554432');
        expect(tableDefinition).not.toMatch(/username|caption|comment_text|source_url/i);
        expect(migration).toContain('ANALYSIS_V2_MEDIA_ARTIFACT_CONFLICT');
        expect(migration).toContain(
            'request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE'
        );
        expect(migration).toContain(
            'REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE'
        );
    });

    it('provides bounded retryable terminal cleanup with an exact cleanup lease', () => {
        expect(migration).toContain('p_limit NOT BETWEEN 1 AND 500');
        expect(migration).toContain('FOR UPDATE OF artifact SKIP LOCKED');
        expect(migration).toContain("analysis_request.status IN ('completed', 'failed')");
        expect(migration).not.toContain('OR artifact.expires_at <= v_now');
        expect(migration).toContain('artifact.object_generation = p_object_generation');
        expect(migration).toContain('artifact.cleanup_token = p_cleanup_token');
    });

    it('exposes only the four service-role RPCs', () => {
        for (const name of [
            'register_analysis_v2_media_artifact',
            'load_analysis_v2_media_artifact',
            'claim_analysis_v2_media_artifact_cleanup',
            'complete_analysis_v2_media_artifact_cleanup',
        ]) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role;`
            ));
        }
    });

    it('keeps every privileged RPC security-definer scoped to an empty search path', () => {
        for (const name of [
            'register_analysis_v2_media_artifact',
            'load_analysis_v2_media_artifact',
            'claim_analysis_v2_media_artifact_cleanup',
            'complete_analysis_v2_media_artifact_cleanup',
        ]) {
            const definition = functionDefinition(name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(definition).not.toMatch(
                /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+analysis_/i
            );
        }
    });
});
