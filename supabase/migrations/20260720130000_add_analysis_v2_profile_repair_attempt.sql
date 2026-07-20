-- Migration A: durable third ("repair") profile-fetch attempt.
-- Adds the attempt domain, the batch bookkeeping, the server-derived repair username set,
-- and the bounded repair checkpoint RPC. No application code calls this yet.

-- 1. Widen the outcome attempt/source domains. Both predicates are strict supersets of
--    the current ones, so every existing row satisfies them; the staging tables are
--    per-request and purged at terminalization, so the validation scan is trivial.
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    DROP CONSTRAINT analysis_v2_profile_outcomes_attempt_check;
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    ADD CONSTRAINT analysis_v2_profile_outcomes_attempt_check CHECK (
        attempt IN ('primary', 'fallback', 'repair')
    );
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    DROP CONSTRAINT analysis_v2_profile_outcomes_source_check;
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    ADD CONSTRAINT analysis_v2_profile_outcomes_source_check CHECK (
        (attempt = 'primary' AND source IN ('cache', 'selfhosted'))
        OR (attempt IN ('fallback', 'repair') AND source = 'apify')
    );

-- 2. Repair bookkeeping on the batch row. All three columns are NULLable with no
--    default, so this is a catalog-only change (no table rewrite) and every existing
--    row trivially satisfies the new CHECKs.
ALTER TABLE public.analysis_v2_profile_fetch_batches
    ADD COLUMN repair_usernames TEXT[],
    ADD COLUMN repair_payload_hash VARCHAR(64),
    ADD COLUMN repair_completed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.analysis_v2_profile_fetch_batches
    ADD CONSTRAINT analysis_v2_profile_batches_repair_pair_check CHECK (
        (repair_usernames IS NULL
         AND repair_payload_hash IS NULL
         AND repair_completed_at IS NULL)
        OR (repair_usernames IS NOT NULL
            AND repair_payload_hash IS NOT NULL
            AND repair_completed_at IS NOT NULL)
    ),
    ADD CONSTRAINT analysis_v2_profile_batches_repair_hash_check CHECK (
        repair_payload_hash IS NULL OR repair_payload_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD CONSTRAINT analysis_v2_profile_batches_repair_subset_check CHECK (
        repair_usernames IS NULL
        OR (
            public.analysis_v2_valid_profile_username_list(repair_usernames, FALSE)
            AND repair_usernames <@ frozen_unresolved_usernames
        )
    ),
    -- Repair may only ever follow a completed fallback, and never precede it in time.
    ADD CONSTRAINT analysis_v2_profile_batches_repair_order_check CHECK (
        repair_completed_at IS NULL
        OR (fallback_completed_at IS NOT NULL
            AND repair_completed_at >= fallback_completed_at)
    );

-- 3. Accept the third attempt in the shared outcome validator.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_outcomes(
    p_outcomes JSONB,
    p_expected_usernames TEXT[],
    p_attempt TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_attempt IN ('primary', 'fallback', 'repair')
       AND public.analysis_v2_valid_profile_username_list(p_expected_usernames, FALSE)
       AND pg_catalog.jsonb_typeof(p_outcomes) = 'array'
       AND pg_catalog.jsonb_array_length(p_outcomes) = pg_catalog.cardinality(p_expected_usernames)
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_outcomes)
                WITH ORDINALITY AS outcome(value, ordinal)
            WHERE pg_catalog.jsonb_typeof(outcome.value) <> 'object'
               OR NOT outcome.value ?& ARRAY[
                    'username', 'source', 'status', 'failure_category', 'http_status',
                    'request_count', 'latency_ms', 'captured_at', 'profile'
               ]
               OR EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_object_keys(outcome.value) AS outcome_key(value)
                    WHERE outcome_key.value <> ALL(ARRAY[
                        'username', 'source', 'status', 'failure_category', 'http_status',
                        'request_count', 'latency_ms', 'captured_at', 'profile'
                    ])
               )
               OR pg_catalog.jsonb_typeof(outcome.value->'username') <> 'string'
               OR outcome.value->>'username' <> p_expected_usernames[outcome.ordinal::INTEGER]
               OR (
                    p_attempt = 'primary'
                    AND outcome.value->>'source' NOT IN ('cache', 'selfhosted')
               )
               OR (
                    p_attempt IN ('fallback', 'repair')
                    AND outcome.value->>'source' <> 'apify'
               )
               OR outcome.value->>'status' NOT IN ('success', 'unavailable', 'failed')
               OR pg_catalog.jsonb_typeof(outcome.value->'request_count') <> 'number'
               OR outcome.value->>'request_count' !~ '^([0-9]|10)$'
               OR pg_catalog.jsonb_typeof(outcome.value->'latency_ms') <> 'number'
               OR outcome.value->>'latency_ms' !~ '^(0|[1-9][0-9]{0,5})$'
               OR (outcome.value->>'latency_ms')::INTEGER > 300000
               OR pg_catalog.jsonb_typeof(outcome.value->'captured_at') <> 'string'
               OR outcome.value->>'captured_at' !~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
               OR (
                    outcome.value->>'status' = 'success'
                    AND (
                        outcome.value->'failure_category' <> 'null'::JSONB
                        OR outcome.value->'http_status' <> 'null'::JSONB
                        OR NOT public.analysis_v2_valid_profile_snapshot(outcome.value->'profile')
                        OR outcome.value->'profile'->>'username' <> outcome.value->>'username'
                    )
               )
               OR (
                    outcome.value->>'status' = 'unavailable'
                    AND (
                        outcome.value->>'failure_category' NOT IN ('not_found', 'empty_user')
                        OR NOT (
                            outcome.value->'http_status' = 'null'::JSONB
                            OR (
                                pg_catalog.jsonb_typeof(outcome.value->'http_status') = 'number'
                                AND outcome.value->>'http_status' = '404'
                            )
                        )
                        OR outcome.value->'profile' <> 'null'::JSONB
                    )
               )
               OR (
                    outcome.value->>'status' = 'failed'
                    AND (
                        outcome.value->>'failure_category' NOT IN (
                            'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                            'transport', 'http', 'unknown'
                        )
                        OR NOT (
                            outcome.value->'http_status' = 'null'::JSONB
                            OR (
                                pg_catalog.jsonb_typeof(outcome.value->'http_status') = 'number'
                                AND outcome.value->>'http_status' ~ '^[45][0-9]{2}$'
                            )
                        )
                        OR outcome.value->'profile' <> 'null'::JSONB
                    )
               )
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_outcomes(JSONB, TEXT[], TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- 4. Server-derived repair set. The client can neither widen nor narrow it.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_repair_username_set(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(pg_catalog.array_agg(merged.username ORDER BY merged.ordinal), '{}')
    FROM (
        SELECT primary_outcome.ordinal,
               primary_outcome.username,
               COALESCE(fallback_outcome.status, primary_outcome.status) AS status
        FROM public.analysis_v2_profile_fetch_outcomes AS primary_outcome
        LEFT JOIN public.analysis_v2_profile_fetch_outcomes AS fallback_outcome
          ON fallback_outcome.request_id = primary_outcome.request_id
         AND fallback_outcome.job_key    = primary_outcome.job_key
         AND fallback_outcome.attempt    = 'fallback'
         AND fallback_outcome.username   = primary_outcome.username
        WHERE primary_outcome.request_id = p_request_id
          AND primary_outcome.job_key    = p_job_key
          AND primary_outcome.attempt    = 'primary'
          AND primary_outcome.status <> 'success'
    ) AS merged
    WHERE merged.status = 'failed';   -- 'unavailable' is deliberately never repaired
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_repair_username_set(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- 5. Snapshot gains repairResults / repairUsernames / repairCapturedAt.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_checkpoint_snapshot(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', batch.request_id,
        'jobKey', batch.job_key,
        'requestedUsernames', pg_catalog.to_jsonb(batch.requested_usernames),
        'frozenUnresolvedUsernames',
            pg_catalog.to_jsonb(batch.frozen_unresolved_usernames),
        'primaryResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'primary'
        ), '[]'::JSONB),
        'fallbackResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'fallback'
        ), '[]'::JSONB),
        'repairResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'repair'
        ), '[]'::JSONB),
        'primaryCapturedAt', batch.primary_completed_at,
        'fallbackCapturedAt', batch.fallback_completed_at,
        'repairUsernames', pg_catalog.to_jsonb(batch.repair_usernames),
        'repairCapturedAt', batch.repair_completed_at
    )
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_checkpoint_snapshot(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- 6. The repair checkpoint RPC. Same lock order, same lease fence, same idempotency
--    shape as checkpoint_analysis_v2_profile_fallback.
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_repair(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_outcomes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_repair TEXT[];
    v_payload_hash TEXT;
    v_completed_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_outcomes) <> 'array' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_completed_at := pg_catalog.clock_timestamp();
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_completed_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT batch.*
    INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key
    FOR UPDATE;
    v_completed_at := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_completed_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_repair := public.analysis_v2_profile_repair_username_set(p_request_id, p_job_key);
    IF NOT FOUND
       OR v_batch.fallback_completed_at IS NULL
       OR pg_catalog.cardinality(v_repair) = 0
       OR NOT public.analysis_v2_valid_profile_outcomes(
            p_outcomes,
            v_repair,
            'repair'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_payload_hash := pg_catalog.encode(
        extensions.digest(p_outcomes::TEXT, 'sha256'),
        'hex'
    );
    IF v_batch.repair_completed_at IS NOT NULL THEN
        IF v_batch.repair_payload_hash <> v_payload_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_REPAIR_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
    END IF;

    INSERT INTO public.analysis_v2_profile_fetch_outcomes (
        request_id,
        job_key,
        attempt,
        ordinal,
        username,
        source,
        status,
        failure_category,
        http_status,
        request_count,
        latency_ms,
        captured_at,
        profile_snapshot
    )
    SELECT
        p_request_id,
        p_job_key,
        'repair',
        outcome.ordinal::SMALLINT,
        outcome.value->>'username',
        outcome.value->>'source',
        outcome.value->>'status',
        NULLIF(outcome.value->>'failure_category', ''),
        CASE
            WHEN outcome.value->'http_status' = 'null'::JSONB THEN NULL
            ELSE (outcome.value->>'http_status')::SMALLINT
        END,
        (outcome.value->>'request_count')::SMALLINT,
        (outcome.value->>'latency_ms')::INTEGER,
        (outcome.value->>'captured_at')::TIMESTAMP WITH TIME ZONE,
        CASE
            WHEN outcome.value->'profile' = 'null'::JSONB THEN NULL
            ELSE outcome.value->'profile'
        END
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    ORDER BY outcome.ordinal;

    v_completed_at := clock_timestamp();
    UPDATE public.analysis_v2_profile_fetch_batches AS batch
    SET repair_usernames = v_repair,
        repair_payload_hash = v_payload_hash,
        repair_completed_at = v_completed_at,
        updated_at = v_completed_at
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_repair(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_repair(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_profile_repair_username_set(UUID, TEXT) IS
    'Server-derived ordered set of still-failed usernames eligible for the at-most-once repair attempt; merged unavailable outcomes are never included.';
COMMENT ON FUNCTION public.checkpoint_analysis_v2_profile_repair(
    UUID, TEXT, UUID, TEXT, JSONB
) IS 'Atomically persists exactly one repair outcome for every username in the server-derived repair set after a completed fallback; exact replay is idempotent and conflicting replay fails closed.';
