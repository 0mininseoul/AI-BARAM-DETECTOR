-- Rebind result cleanup and finalization after the rich AI scoring stage exists.
-- The original result migration intentionally remains deployable earlier in the chain;
-- this migration converts its dynamic compatibility fence into the final static boundary.

-- Non-batch checkpoints deliberately pass NULL for p_batch. The original STRICT declaration
-- short-circuited those calls to NULL instead of hashing the canonical '-' batch sentinel.
CREATE OR REPLACE FUNCTION public.analysis_v2_result_staging_hash(
    p_kind TEXT,
    p_batch INTEGER,
    p_rows JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
CALLED ON NULL INPUT
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_kind IS NULL OR p_rows IS NULL THEN NULL
        ELSE pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    pg_catalog.concat_ws(
                        E'\n',
                        'analysis-v2-result-staging:v1',
                        p_kind,
                        COALESCE(p_batch::TEXT, '-'),
                        p_rows::TEXT
                    ),
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
        )
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_staging_hash(TEXT, INTEGER, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- The public checkpoint receipt has the same nullable batch sentinel. It must return a JSON
-- receipt for singleton stages instead of silently returning SQL NULL after persisting them.
CREATE OR REPLACE FUNCTION public.analysis_v2_result_checkpoint_json(
    p_request_id UUID,
    p_job_key TEXT,
    p_batch INTEGER,
    p_item_count INTEGER,
    p_row_count INTEGER,
    p_result_hash TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
CALLED ON NULL INPUT
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_request_id IS NULL OR p_job_key IS NULL
          OR p_item_count IS NULL OR p_row_count IS NULL OR p_result_hash IS NULL
        THEN NULL
        ELSE pg_catalog.jsonb_build_object(
            'requestId', p_request_id,
            'jobKey', p_job_key,
            'batch', p_batch,
            'itemCount', p_item_count,
            'rowCount', p_row_count,
            'resultHash', p_result_hash
        )
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_checkpoint_json(
    UUID, TEXT, INTEGER, INTEGER, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- A retry owns the same immutable job/input identity but receives a fresh lease token. Once the
-- current live lease is proven under the canonical preflight -> request -> job lock order, hand
-- any prior result checkpoint for that exact producer to the new claim. The checkpoint function
-- still compares item count, result hash, and stage-specific metadata afterwards; a drifting
-- replay raises and rolls this token update back with the statement.
CREATE OR REPLACE FUNCTION public.analysis_v2_assert_result_job_fence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS public.analysis_pipeline_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_candidate_feature_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_preliminary_score_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_reverse_like_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_partner_safety_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_candidate_score_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_private_name_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;
    UPDATE public.analysis_v2_narrative_manifests
    SET producer_claim_token = p_claim_token
    WHERE request_id = p_request_id
      AND producer_job_key = p_job_key
      AND producer_input_hash = p_job_input_hash
      AND producer_claim_token IS DISTINCT FROM p_claim_token;

    RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_assert_result_job_fence(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(
    p_request_id UUID,
    p_keep_final BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL OR p_keep_final IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    DELETE FROM public.analysis_v2_narrative_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_partner_safety_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_reverse_like_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_preliminary_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_private_name_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_feature_manifests WHERE request_id = p_request_id;

    DELETE FROM public.analysis_v2_ai_result_checkpoints WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_profile_fetch_batches WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_target_evidence_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_sides WHERE request_id = p_request_id;

    IF NOT p_keep_final THEN
        DELETE FROM public.analysis_v2_result_summaries WHERE request_id = p_request_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_purge_result_working_set(UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) RENAME TO analysis_v2_complete_result_and_purge_internal;

REVOKE ALL ON FUNCTION public.analysis_v2_complete_result_and_purge_internal(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF pg_catalog.to_regclass(
        'public.analysis_v2_ai_scoring_stage_checkpoints'
    ) IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_complete_result_and_purge_internal(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash,
        p_target_profile_image_url
    );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_purge_result_working_set(UUID, BOOLEAN) IS
    'Terminal PII purge rebound after every V2 AI staging relation exists.';
COMMENT ON FUNCTION public.analysis_v2_complete_result_and_purge_internal(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Revoked exact-lease result finalizer implementation; callable only through the schema-readiness wrapper.';
COMMENT ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Service-only result finalizer wrapper that fails closed when the complete V2 scoring schema is unavailable.';
