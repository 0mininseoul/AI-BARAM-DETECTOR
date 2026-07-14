-- Phase F: durable paid-provider run ledger for V2 jobs.
-- The reservation is committed before an Actor start. A current job claim is required to
-- reserve or attach a run ID, while terminal reconciliation uses the stored reservation and
-- claim fences so a provider response can still be recorded after a worker lease expires.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_provider_operation_key(
    p_operation_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.char_length(p_operation_key) BETWEEN 78 AND 87
       AND p_operation_key ~ '^(target-profile|profile-fallback|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$';
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_provider_operation_key(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(87) NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    job_claim_token UUID NOT NULL,
    reservation_token UUID NOT NULL,
    logical_provider VARCHAR(16) NOT NULL,
    actor_id VARCHAR(200) NOT NULL,
    credential_slot VARCHAR(16) NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'starting',
    run_id VARCHAR(64),
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    UNIQUE (reservation_token),
    UNIQUE (run_id),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE CASCADE,
    CONSTRAINT analysis_v2_provider_run_job_key_check CHECK (
        pg_catalog.char_length(job_key) BETWEEN 1 AND 160
        AND job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    CONSTRAINT analysis_v2_provider_run_operation_key_check CHECK (
        public.analysis_v2_valid_provider_operation_key(operation_key)
    ),
    CONSTRAINT analysis_v2_provider_run_input_hash_check CHECK (
        input_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_provider_run_provider_check CHECK (
        logical_provider IN ('apify', 'coderx')
    ),
    CONSTRAINT analysis_v2_provider_run_actor_check CHECK (
        pg_catalog.char_length(actor_id) BETWEEN 3 AND 200
        AND actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
    ),
    CONSTRAINT analysis_v2_provider_run_credential_check CHECK (
        credential_slot IN ('primary', 'secondary')
    ),
    CONSTRAINT analysis_v2_provider_run_status_check CHECK (
        status IN ('starting', 'running', 'succeeded', 'failed', 'aborted', 'timed_out')
    ),
    CONSTRAINT analysis_v2_provider_run_run_id_check CHECK (
        run_id IS NULL OR run_id ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT analysis_v2_provider_run_cost_check CHECK (
        max_charge_usd BETWEEN 0 AND 100000
        AND (actual_usage_usd IS NULL OR actual_usage_usd BETWEEN 0 AND 100000)
    ),
    CONSTRAINT analysis_v2_provider_run_state_check CHECK (
        (
            status = 'starting'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
        )
        OR (
            status = 'running'
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
        )
        OR (
            status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND terminalized_at IS NOT NULL
            AND (
                (actual_usage_usd IS NULL AND usage_reconciled_at IS NULL)
                OR (actual_usage_usd IS NOT NULL AND usage_reconciled_at IS NOT NULL)
            )
        )
    ),
    CONSTRAINT analysis_v2_provider_run_time_check CHECK (
        updated_at >= reserved_at
        AND (run_started_at IS NULL OR run_started_at >= reserved_at)
        AND (terminalized_at IS NULL OR terminalized_at >= run_started_at)
        AND (usage_reconciled_at IS NULL OR usage_reconciled_at >= terminalized_at)
    )
);

CREATE INDEX idx_analysis_v2_provider_runs_request_status
    ON public.analysis_v2_provider_runs(request_id, status, job_key, operation_key);
CREATE INDEX idx_analysis_v2_provider_runs_unreconciled
    ON public.analysis_v2_provider_runs(terminalized_at, request_id, job_key, operation_key)
    WHERE status IN ('succeeded', 'failed', 'aborted', 'timed_out')
      AND actual_usage_usd IS NULL;

COMMENT ON TABLE public.analysis_v2_provider_runs IS
    'RPC-only, PII-free intent, run, and terminal cost ledger for paid V2 provider operations.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.operation_key IS
    'A fixed operation kind plus SHA-256 digest. Usernames, post URLs, captions, and evidence are forbidden.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.input_hash IS
    'SHA-256 of the bounded canonical provider input; the raw provider input is never stored here.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.job_claim_token IS
    'Mutable takeover fence rebound only by an active processing job with a live matching lease.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.reservation_token IS
    'Stable provider-start fence retained across job retries and ambiguous RPC responses.';

ALTER TABLE public.analysis_v2_provider_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_runs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_provider_run_json(
    p_run public.analysis_v2_provider_runs
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_run.request_id,
        'jobKey', p_run.job_key,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'reservationToken', p_run.reservation_token,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status,
        'runId', p_run.run_id,
        'actualUsageUsd', p_run.actual_usage_usd,
        'reservedAt', p_run.reserved_at,
        'runStartedAt', p_run.run_started_at,
        'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_provider_run_json(public.analysis_v2_provider_runs)
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
       OR p_credential_slot IS NULL
       OR p_credential_slot NOT IN ('primary', 'secondary')
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

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_provider_run_started(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_reservation_token UUID,
    p_run_id TEXT
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
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
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
    INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.job_claim_token IS DISTINCT FROM p_claim_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status <> 'starting' THEN
        IF v_run.run_id IS DISTINCT FROM p_run_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RUN_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = 'running',
        run_id = p_run_id,
        run_started_at = v_now,
        updated_at = v_now
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    RETURNING provider_run.* INTO v_run;

    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_provider_run_started(
    UUID, TEXT, UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_provider_run_started(
    UUID, TEXT, UUID, TEXT, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_provider_run_terminal(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_reservation_token UUID,
    p_run_id TEXT,
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
    v_preflight_id UUID;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR (
            p_actual_usage_usd IS NOT NULL
            AND (
                p_actual_usage_usd NOT BETWEEN 0 AND 100000
                OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Terminal persistence deliberately takes the canonical locks but does not require a live
    -- lease. The row's stored reservation and claim are the response-loss fence.
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
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
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
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.job_claim_token IS DISTINCT FROM p_claim_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.run_id IS DISTINCT FROM p_run_id OR v_run.status = 'starting' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RUN_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN
        IF v_run.status IS DISTINCT FROM p_status THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_TERMINAL_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        -- Null is "not yet observed". It may be replayed after reconciliation; a concrete
        -- amount can fill the value once but can never replace another concrete amount.
        IF p_actual_usage_usd IS NOT NULL
           AND v_run.actual_usage_usd IS NOT NULL
           AND v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_TERMINAL_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL THEN
            UPDATE public.analysis_v2_provider_runs AS provider_run
            SET actual_usage_usd = p_actual_usage_usd,
                usage_reconciled_at = v_now,
                updated_at = v_now
            WHERE provider_run.request_id = p_request_id
              AND provider_run.job_key = p_job_key
              AND provider_run.operation_key = p_operation_key
            RETURNING provider_run.* INTO v_run;
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;

    IF v_run.status <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = p_status,
        actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now,
        usage_reconciled_at = CASE
            WHEN p_actual_usage_usd IS NULL THEN NULL
            ELSE v_now
        END,
        updated_at = v_now
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    RETURNING provider_run.* INTO v_run;

    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_provider_run_terminal(
    UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_provider_run_terminal(
    UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_provider_run(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_provider_run(UUID, TEXT, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_v2_unreconciled_provider_runs(
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'requestId', candidate.request_id,
                'jobKey', candidate.job_key,
                'operationKey', candidate.operation_key,
                'inputHash', candidate.input_hash,
                'reservationToken', candidate.reservation_token,
                'logicalProvider', candidate.logical_provider,
                'actorId', candidate.actor_id,
                'credentialSlot', candidate.credential_slot,
                'maxChargeUsd', candidate.max_charge_usd,
                'status', candidate.status,
                'runId', candidate.run_id,
                'actualUsageUsd', candidate.actual_usage_usd,
                'reservedAt', candidate.reserved_at,
                'runStartedAt', candidate.run_started_at,
                'terminalizedAt', candidate.terminalized_at,
                'usageReconciledAt', candidate.usage_reconciled_at
            ) ORDER BY
                candidate.terminalized_at,
                candidate.request_id,
                candidate.job_key,
                candidate.operation_key
        ),
        '[]'::JSONB
    )
    INTO v_runs
    FROM (
        SELECT provider_run.*
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
          AND provider_run.actual_usage_usd IS NULL
          AND provider_run.usage_reconciled_at IS NULL
          AND provider_run.terminalized_at <= (
              pg_catalog.clock_timestamp() - INTERVAL '30 seconds'
          )
        ORDER BY
            provider_run.terminalized_at,
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key
        LIMIT p_limit
    ) AS candidate;

    RETURN v_runs;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_unreconciled_provider_runs(INTEGER)
    TO service_role;

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
       OR p_credential_slot IS NULL
       OR p_credential_slot NOT IN ('primary', 'secondary')
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
