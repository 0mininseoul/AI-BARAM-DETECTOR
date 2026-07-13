-- PostgreSQL requires RETURN QUERY expressions to match RETURNS TABLE types
-- exactly. The underlying columns are VARCHAR while the RPC contract is TEXT.
CREATE OR REPLACE FUNCTION public.claim_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE(
    preflight_id UUID,
    user_id UUID,
    claimed BOOLEAN,
    target_instagram_id TEXT,
    access_mode TEXT,
    plan_catalog_snapshot JSONB,
    pricing_version TEXT,
    pricing_snapshot JSONB,
    worker_attempt_count INTEGER,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    preflight_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_lease_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds < 30
       OR p_lease_seconds > 300 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.expires_at <= v_now THEN
        IF v_preflight.status IN ('pending', 'processing', 'ready') THEN
            UPDATE public.analysis_preflights
            SET status = 'expired',
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_preflight.id;
        END IF;
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode::TEXT, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version::TEXT, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            NULL::TIMESTAMPTZ, 'expired'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status = 'processing'
       AND v_preflight.lease_token = p_claim_token
       AND v_preflight.lease_expires_at > v_now THEN
        v_lease_expires_at := LEAST(
            v_preflight.expires_at,
            v_now + pg_catalog.make_interval(secs => p_lease_seconds)
        );
        UPDATE public.analysis_preflights
        SET lease_expires_at = v_lease_expires_at,
            updated_at = v_now
        WHERE id = v_preflight.id;
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, TRUE,
            v_preflight.target_instagram_id::TEXT,
            v_preflight.access_mode::TEXT, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version::TEXT, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            v_lease_expires_at, 'processing'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status = 'processing' AND v_preflight.lease_expires_at > v_now THEN
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode::TEXT, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version::TEXT, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            v_preflight.lease_expires_at, 'processing'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status NOT IN ('pending', 'processing') THEN
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode::TEXT, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version::TEXT, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            NULL::TIMESTAMPTZ, v_preflight.status::TEXT;
        RETURN;
    END IF;

    IF v_preflight.worker_attempt_count >= 7 THEN
        UPDATE public.analysis_preflights
        SET status = 'blocked',
            error_code = 'ANALYSIS_FAILED',
            blocked_at = v_now,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = v_now
        WHERE id = v_preflight.id;
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode::TEXT, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version::TEXT, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            NULL::TIMESTAMPTZ, 'blocked'::TEXT;
        RETURN;
    END IF;

    v_lease_expires_at := LEAST(
        v_preflight.expires_at,
        v_now + pg_catalog.make_interval(secs => p_lease_seconds)
    );
    UPDATE public.analysis_preflights AS preflight
    SET status = 'processing',
        worker_attempt_count = preflight.worker_attempt_count + 1,
        lease_token = p_claim_token,
        lease_expires_at = v_lease_expires_at,
        claimed_at = v_now,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY
    SELECT v_preflight.id, v_preflight.user_id, TRUE,
        v_preflight.target_instagram_id::TEXT,
        v_preflight.access_mode::TEXT, v_preflight.plan_catalog_snapshot,
        v_preflight.pricing_version::TEXT, v_preflight.pricing_snapshot,
        v_preflight.worker_attempt_count + 1,
        v_lease_expires_at, 'processing'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER)
    TO service_role;

-- The output parameter named request_id makes an unqualified
-- ON CONFLICT (request_id, job_key) ambiguous inside PL/pgSQL.
CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT
)
RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request_id UUID;
    v_created BOOLEAN;
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_input_hash TEXT;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    SELECT consumed.request_id, consumed.created
    INTO v_request_id, v_created
    FROM public.consume_analysis_v2_test_entitlement_pre_job(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash
    ) AS consumed;

    IF v_request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = v_request_id
      AND analysis_request.user_id = p_user_id
      AND analysis_request.preflight_id = p_preflight_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_request.pipeline_version <> 'v2'
       OR v_request.plan_access_mode_snapshot <> 'test_entitlement'
       OR v_request.selected_plan_id_snapshot <> p_selected_plan_id
       OR v_request.test_entitlement_jti_hash <> p_entitlement_jti_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_input_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-job-input-v1'
                    || pg_catalog.chr(10)
                    || pg_catalog.lower(v_request_id::TEXT)
                    || pg_catalog.chr(10)
                    || v_initial_job_key,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    INSERT INTO public.analysis_pipeline_jobs (
        request_id,
        job_key,
        track,
        kind,
        batch,
        input_hash,
        required_job_keys
    ) VALUES (
        v_request_id,
        v_initial_job_key,
        'coordinator',
        'bootstrap',
        NULL,
        v_input_hash,
        '{}'::TEXT[]
    )
    ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = v_request_id
      AND job.job_key = v_initial_job_key
    FOR UPDATE;

    IF NOT FOUND
       OR v_job.track <> 'coordinator'
       OR v_job.kind <> 'bootstrap'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash <> v_input_hash
       OR v_job.required_job_keys <> '{}'::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT
        v_request_id,
        v_created,
        v_initial_job_key,
        v_request.status::TEXT,
        v_request.background_processing;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT) IS
    'Atomically consumes/replays one entitlement, ensures coordinator:bootstrap, and returns the immutable request identity plus its current execution state.';
