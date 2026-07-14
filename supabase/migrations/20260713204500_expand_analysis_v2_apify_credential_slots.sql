-- V2 canaries may explicitly select one of five stored Apify credentials. Selection is
-- deployment-scoped and immutable per provider run; no RPC rotates or pools credentials.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN ('primary', 'secondary', 'tertiary', 'quaternary', 'quinary'),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_provider_runs
    DROP CONSTRAINT analysis_v2_provider_run_credential_check,
    ADD CONSTRAINT analysis_v2_provider_run_credential_check CHECK (
        public.analysis_v2_valid_apify_credential_slot(credential_slot)
    );

ALTER TABLE public.analysis_v2_relationship_sides
    DROP CONSTRAINT analysis_v2_relationship_sides_credential_check,
    ADD CONSTRAINT analysis_v2_relationship_sides_credential_check CHECK (
        provider_credential_slot IS NULL
        OR public.analysis_v2_valid_apify_credential_slot(provider_credential_slot)
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_target_evidence_source(
    p_signal TEXT,
    p_source JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_signal IN ('target_post_like', 'target_post_comment')
       AND p_source IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_source) = 'object'
       AND p_source ?& ARRAY[
            'status', 'input_hash', 'provider', 'provider_run_id',
            'provider_operation_key', 'provider_credential_slot', 'coverage'
       ]
       AND p_source - ARRAY[
            'status', 'input_hash', 'provider', 'provider_run_id',
            'provider_operation_key', 'provider_credential_slot', 'coverage'
       ] = '{}'::JSONB
       AND pg_catalog.jsonb_typeof(p_source->'status') = 'string'
       AND p_source->>'status' IN ('collected', 'not_applicable')
       AND pg_catalog.jsonb_typeof(p_source->'input_hash') = 'string'
       AND p_source->>'input_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_source->'coverage') = 'array'
       AND pg_catalog.jsonb_array_length(p_source->'coverage') <= CASE p_signal
            WHEN 'target_post_like' THEN 4 ELSE 6
       END
       AND (
            (
                p_source->>'status' = 'not_applicable'
                AND p_source->'provider' = 'null'::JSONB
                AND p_source->'provider_run_id' = 'null'::JSONB
                AND p_source->'provider_operation_key' = 'null'::JSONB
                AND p_source->'provider_credential_slot' = 'null'::JSONB
                AND pg_catalog.jsonb_array_length(p_source->'coverage') = 0
            )
            OR (
                p_source->>'status' = 'collected'
                AND pg_catalog.jsonb_typeof(p_source->'provider') = 'string'
                AND p_source->>'provider' IN ('apify', 'coderx')
                AND pg_catalog.jsonb_typeof(p_source->'provider_run_id') = 'string'
                AND p_source->>'provider_run_id' ~ '^[A-Za-z0-9]{8,64}$'
                AND pg_catalog.jsonb_typeof(p_source->'provider_operation_key') = 'string'
                AND p_source->>'provider_operation_key' ~ CASE p_signal
                    WHEN 'target_post_like' THEN '^target-likers:[0-9a-f]{64}$'
                    ELSE '^target-comments:[0-9a-f]{64}$'
                END
                AND pg_catalog.jsonb_typeof(p_source->'provider_credential_slot') = 'string'
                AND public.analysis_v2_valid_apify_credential_slot(
                    p_source->>'provider_credential_slot'
                )
                AND pg_catalog.jsonb_array_length(p_source->'coverage') >= 1
            )
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage') AS coverage(value)
            WHERE pg_catalog.jsonb_typeof(coverage.value) <> 'object'
               OR NOT coverage.value ?& ARRAY[
                    'post_id', 'declared_count', 'returned_count', 'requested_limit'
               ]
               OR coverage.value - ARRAY[
                    'post_id', 'declared_count', 'returned_count', 'requested_limit'
               ] <> '{}'::JSONB
               OR pg_catalog.jsonb_typeof(coverage.value->'post_id') <> 'string'
               OR pg_catalog.char_length(coverage.value->>'post_id') NOT BETWEEN 1 AND 255
               OR coverage.value->>'post_id' ~ '[[:cntrl:]]'
               OR pg_catalog.jsonb_typeof(coverage.value->'declared_count') <> 'number'
               OR coverage.value->>'declared_count' !~ '^(0|[1-9][0-9]{0,7})$'
               OR (coverage.value->>'declared_count')::INTEGER > 10000000
               OR pg_catalog.jsonb_typeof(coverage.value->'returned_count') <> 'number'
               OR coverage.value->>'returned_count' !~ '^(0|[1-9][0-9]{0,2})$'
               OR (coverage.value->>'returned_count')::INTEGER > CASE p_signal
                    WHEN 'target_post_like' THEN 150 ELSE 15
               END
               OR pg_catalog.jsonb_typeof(coverage.value->'requested_limit') <> 'number'
               OR coverage.value->>'requested_limit' !~ '^(15|150)$'
               OR (coverage.value->>'requested_limit')::INTEGER <> CASE p_signal
                    WHEN 'target_post_like' THEN 150 ELSE 15
               END
               OR (coverage.value->>'returned_count')::INTEGER
                    > (coverage.value->>'requested_limit')::INTEGER
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage') AS coverage(value)
            GROUP BY coverage.value->>'post_id'
            HAVING pg_catalog.count(*) > 1
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_target_evidence_source(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight_id UUID;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR pg_catalog.char_length(p_actor_id) NOT BETWEEN 3 AND 200
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.id
    INTO v_preflight_id
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_existing
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
           OR v_existing.actor_id IS DISTINCT FROM p_actor_id
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        IF v_existing.job_claim_token IS DISTINCT FROM p_claim_token THEN
            UPDATE public.analysis_v2_provider_runs AS provider_run
            SET job_claim_token = p_claim_token,
                updated_at = v_now
            WHERE provider_run.request_id = p_request_id
              AND provider_run.job_key = p_job_key
              AND provider_run.operation_key = p_operation_key
            RETURNING provider_run.* INTO v_existing;
        END IF;

        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE,
            'run', public.analysis_v2_provider_run_json(v_existing)
        );
    END IF;

    INSERT INTO public.analysis_v2_provider_runs (
        request_id,
        job_key,
        operation_key,
        input_hash,
        job_claim_token,
        reservation_token,
        logical_provider,
        actor_id,
        credential_slot,
        max_charge_usd
    ) VALUES (
        p_request_id,
        p_job_key,
        p_operation_key,
        p_input_hash,
        p_claim_token,
        p_reservation_token,
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        p_max_charge_usd
    )
    RETURNING * INTO v_existing;

    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE,
        'run', public.analysis_v2_provider_run_json(v_existing)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_analysis_v2_provider_run_usage(
    p_reservation_token UUID,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_status TEXT,
    p_actual_usage_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR pg_catalog.char_length(p_actor_id) NOT BETWEEN 3 AND 200
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_actual_usage_usd IS NULL
       OR p_actual_usage_usd NOT BETWEEN 0 AND 100000
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = p_reservation_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.status IS DISTINCT FROM p_status
       OR v_run.status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR v_run.terminalized_at IS NULL
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.terminalized_at > (v_now - INTERVAL '30 seconds') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.actual_usage_usd IS NOT NULL THEN
        IF v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET actual_usage_usd = p_actual_usage_usd,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.request_id = v_run.request_id
      AND provider_run.job_key = v_run.job_key
      AND provider_run.operation_key = v_run.operation_key
    RETURNING provider_run.* INTO v_run;

    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_analysis_v2_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_analysis_v2_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT) IS
    'V2-only explicit Apify credential identity; callers never rotate between slots automatically.';
