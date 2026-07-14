-- Phase E: private, content-addressed normalized media artifacts shared by AI jobs.
-- Object bytes live only in a private GCS bucket. This table retains opaque hashes and exact
-- generations so terminal cleanup can be retried without retaining usernames, URLs, or captions.

CREATE TABLE public.analysis_v2_media_artifacts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    artifact_key VARCHAR(64) NOT NULL,
    registration_job_key VARCHAR(160) NOT NULL,
    artifact_kind VARCHAR(16) NOT NULL,
    content_sha256 VARCHAR(64) NOT NULL,
    content_type VARCHAR(32) NOT NULL,
    object_name VARCHAR(256) NOT NULL,
    object_generation VARCHAR(32) NOT NULL,
    byte_size INTEGER NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    cleanup_token UUID,
    cleanup_lease_expires_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, artifact_key),
    UNIQUE (object_name, object_generation),
    FOREIGN KEY (request_id, registration_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_media_artifact_key_check CHECK (
        artifact_key ~ '^[a-f0-9]{64}$'
        AND content_sha256 ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_v2_media_artifact_job_key_check CHECK (
        pg_catalog.char_length(registration_job_key) BETWEEN 1 AND 160
        AND registration_job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    CONSTRAINT analysis_v2_media_artifact_object_check CHECK (
        pg_catalog.char_length(object_name) BETWEEN 1 AND 256
        AND object_name ~ '^analysis-v2/[0-9a-f-]{36}/[a-f0-9]{64}/[a-f0-9]{64}\.(jpg|bin)$'
        AND object_name LIKE 'analysis-v2/' || request_id::TEXT || '/' || artifact_key || '/%'
        AND object_generation ~ '^[1-9][0-9]{0,31}$'
        AND (
            (
                artifact_kind = 'jpeg'
                AND content_type = 'image/jpeg'
                AND object_name LIKE '%.jpg'
                AND byte_size BETWEEN 4 AND 8388608
            )
            OR (
                artifact_kind = 'media_bundle'
                AND content_type = 'application/octet-stream'
                AND object_name LIKE '%.bin'
                AND byte_size BETWEEN 16 AND 33554432
            )
        )
    ),
    CONSTRAINT analysis_v2_media_artifact_expiry_check CHECK (
        expires_at > created_at
        AND expires_at <= created_at + INTERVAL '24 hours'
    ),
    CONSTRAINT analysis_v2_media_artifact_cleanup_check CHECK (
        (
            deleted_at IS NULL
            AND (
                (cleanup_token IS NULL AND cleanup_lease_expires_at IS NULL)
                OR (
                    cleanup_token IS NOT NULL
                    AND cleanup_lease_expires_at IS NOT NULL
                    AND cleanup_lease_expires_at > created_at
                )
            )
        )
        OR (
            deleted_at IS NOT NULL
            AND deleted_at >= created_at
            AND cleanup_token IS NULL
            AND cleanup_lease_expires_at IS NULL
        )
    )
);

CREATE INDEX idx_analysis_v2_media_artifacts_cleanup
    ON public.analysis_v2_media_artifacts(
        COALESCE(cleanup_lease_expires_at, expires_at), request_id, artifact_key
    )
    WHERE deleted_at IS NULL;

ALTER TABLE public.analysis_v2_media_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_media_artifacts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_media_artifacts
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_media_artifacts IS
    'RPC-only PII-free registry for private normalized JPEGs and per-profile media bundles. No username, source URL, caption, comment, prompt, or image bytes may be stored here.';
COMMENT ON COLUMN public.analysis_v2_media_artifacts.artifact_key IS
    'Domain-separated SHA-256 of the stable media selection identifier.';
COMMENT ON COLUMN public.analysis_v2_media_artifacts.object_generation IS
    'Exact immutable GCS generation used for read and delete preconditions.';

CREATE OR REPLACE FUNCTION public.register_analysis_v2_media_artifact(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_artifact_key TEXT,
    p_artifact_kind TEXT,
    p_content_sha256 TEXT,
    p_content_type TEXT,
    p_object_name TEXT,
    p_object_generation TEXT,
    p_byte_size INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_media_artifacts%ROWTYPE;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_claim_token IS NULL
       OR p_artifact_key IS NULL
       OR p_artifact_kind IS NULL
       OR p_content_sha256 IS NULL
       OR p_content_type IS NULL
       OR p_object_name IS NULL
       OR p_object_generation IS NULL
       OR p_byte_size IS NULL
       OR p_artifact_key !~ '^[a-f0-9]{64}$'
       OR p_content_sha256 !~ '^[a-f0-9]{64}$'
       OR p_object_generation !~ '^[1-9][0-9]{0,31}$'
       OR (
            (p_artifact_kind = 'jpeg'
                AND p_content_type = 'image/jpeg'
                AND p_byte_size BETWEEN 4 AND 8388608)
            OR (p_artifact_kind = 'media_bundle'
                AND p_content_type = 'application/octet-stream'
                AND p_byte_size BETWEEN 16 AND 33554432)
       ) IS NOT TRUE
       OR p_object_name <> 'analysis-v2/' || p_request_id::TEXT || '/'
            || p_artifact_key || '/' || p_content_sha256
            || (CASE p_artifact_kind WHEN 'jpeg' THEN '.jpg' ELSE '.bin' END) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Preserve the canonical terminal-capable lock order.
    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;

    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.request_id IS NULL
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT artifact.*
    INTO v_existing
    FROM public.analysis_v2_media_artifacts AS artifact
    WHERE artifact.request_id = p_request_id
      AND artifact.artifact_key = p_artifact_key
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.registration_job_key IS DISTINCT FROM p_job_key
           OR v_existing.artifact_kind IS DISTINCT FROM p_artifact_kind
           OR v_existing.content_sha256 IS DISTINCT FROM p_content_sha256
           OR v_existing.content_type IS DISTINCT FROM p_content_type
           OR v_existing.object_name IS DISTINCT FROM p_object_name
           OR v_existing.object_generation IS DISTINCT FROM p_object_generation
           OR v_existing.byte_size IS DISTINCT FROM p_byte_size
           OR v_existing.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        INSERT INTO public.analysis_v2_media_artifacts (
            request_id,
            artifact_key,
            registration_job_key,
            artifact_kind,
            content_sha256,
            content_type,
            object_name,
            object_generation,
            byte_size,
            expires_at,
            created_at
        ) VALUES (
            p_request_id,
            p_artifact_key,
            p_job_key,
            p_artifact_kind,
            p_content_sha256,
            p_content_type,
            p_object_name,
            p_object_generation,
            p_byte_size,
            v_now + INTERVAL '6 hours',
            v_now
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'artifactKey', p_artifact_key,
        'artifactKind', p_artifact_kind,
        'contentSha256', p_content_sha256,
        'contentType', p_content_type,
        'objectName', p_object_name,
        'objectGeneration', p_object_generation,
        'byteSize', p_byte_size
    );
END;
$$;

REVOKE ALL ON FUNCTION public.register_analysis_v2_media_artifact(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_analysis_v2_media_artifact(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_media_artifact(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_artifact_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_artifact public.analysis_v2_media_artifacts%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_claim_token IS NULL
       OR p_artifact_key IS NULL
       OR p_artifact_key !~ '^[a-f0-9]{64}$'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            JOIN public.analysis_pipeline_jobs AS job
              ON job.request_id = analysis_request.id
            WHERE analysis_request.id = p_request_id
              AND analysis_request.pipeline_version = 'v2'
              AND analysis_request.status IN ('pending', 'processing')
              AND job.job_key = p_job_key
              AND job.status = 'processing'
              AND job.lease_token = p_claim_token
              AND job.lease_expires_at > pg_catalog.clock_timestamp()
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT artifact.*
    INTO v_artifact
    FROM public.analysis_v2_media_artifacts AS artifact
    WHERE artifact.request_id = p_request_id
      AND artifact.artifact_key = p_artifact_key
      AND artifact.deleted_at IS NULL;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_artifact.request_id,
        'artifactKey', v_artifact.artifact_key,
        'artifactKind', v_artifact.artifact_kind,
        'contentSha256', v_artifact.content_sha256,
        'contentType', v_artifact.content_type,
        'objectName', v_artifact.object_name,
        'objectGeneration', v_artifact.object_generation,
        'byteSize', v_artifact.byte_size
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_media_artifact(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_media_artifact(UUID, TEXT, UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_media_artifact_cleanup(
    p_limit INTEGER DEFAULT 100,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_result JSONB;
BEGIN
    IF p_limit NOT BETWEEN 1 AND 500 OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    WITH candidates AS (
        SELECT artifact.request_id, artifact.artifact_key
        FROM public.analysis_v2_media_artifacts AS artifact
        JOIN public.analysis_requests AS analysis_request
          ON analysis_request.id = artifact.request_id
        WHERE artifact.deleted_at IS NULL
          AND analysis_request.status IN ('completed', 'failed')
          AND (
              artifact.cleanup_token IS NULL
              OR artifact.cleanup_lease_expires_at <= v_now
          )
        ORDER BY artifact.expires_at, artifact.request_id, artifact.artifact_key
        LIMIT p_limit
        FOR UPDATE OF artifact SKIP LOCKED
    ), claimed AS (
        UPDATE public.analysis_v2_media_artifacts AS artifact
        SET cleanup_token = extensions.gen_random_uuid(),
            cleanup_lease_expires_at = v_now
                + pg_catalog.make_interval(secs => p_lease_seconds)
        FROM candidates
        WHERE artifact.request_id = candidates.request_id
          AND artifact.artifact_key = candidates.artifact_key
        RETURNING artifact.*
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'requestId', claimed.request_id,
            'artifactKey', claimed.artifact_key,
            'artifactKind', claimed.artifact_kind,
            'contentSha256', claimed.content_sha256,
            'contentType', claimed.content_type,
            'objectName', claimed.object_name,
            'objectGeneration', claimed.object_generation,
            'byteSize', claimed.byte_size,
            'cleanupToken', claimed.cleanup_token
        )
        ORDER BY claimed.expires_at, claimed.request_id, claimed.artifact_key
    ), '[]'::JSONB)
    INTO v_result
    FROM claimed;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_analysis_v2_media_artifact_cleanup(INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_media_artifact_cleanup(INTEGER, INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_media_artifact_cleanup(
    p_request_id UUID,
    p_artifact_key TEXT,
    p_object_generation TEXT,
    p_cleanup_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_updated INTEGER;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_request_id IS NULL
       OR p_artifact_key IS NULL
       OR p_object_generation IS NULL
       OR p_artifact_key !~ '^[a-f0-9]{64}$'
       OR p_object_generation !~ '^[1-9][0-9]{0,31}$'
       OR p_cleanup_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_media_artifacts AS artifact
    SET deleted_at = v_now,
        cleanup_token = NULL,
        cleanup_lease_expires_at = NULL
    WHERE artifact.request_id = p_request_id
      AND artifact.artifact_key = p_artifact_key
      AND artifact.object_generation = p_object_generation
      AND artifact.cleanup_token = p_cleanup_token
      AND artifact.cleanup_lease_expires_at > v_now
      AND artifact.deleted_at IS NULL;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 1 THEN
        RETURN TRUE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_media_artifacts AS artifact
        WHERE artifact.request_id = p_request_id
          AND artifact.artifact_key = p_artifact_key
          AND artifact.object_generation = p_object_generation
          AND artifact.deleted_at IS NOT NULL
    ) THEN
        RETURN FALSE;
    END IF;

    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_V2_MEDIA_ARTIFACT_CLEANUP_FENCE_MISMATCH',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_media_artifact_cleanup(
    UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_media_artifact_cleanup(
    UUID, TEXT, TEXT, UUID
) TO service_role;

COMMENT ON FUNCTION public.register_analysis_v2_media_artifact(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER
) IS 'Registers an immutable private artifact only while the exact V2 job lease is live; exact replay is idempotent and drift fails closed.';
COMMENT ON FUNCTION public.load_analysis_v2_media_artifact(UUID, TEXT, UUID, TEXT) IS
    'Loads only an opaque artifact reference while the requesting V2 job lease is live.';
COMMENT ON FUNCTION public.claim_analysis_v2_media_artifact_cleanup(INTEGER, INTEGER) IS
    'Claims bounded terminal private objects for retryable generation-fenced cleanup.';
COMMENT ON FUNCTION public.complete_analysis_v2_media_artifact_cleanup(UUID, TEXT, TEXT, UUID) IS
    'Marks an artifact generation deleted only under its exact cleanup lease.';
