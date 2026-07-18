-- Crash-safe, PII-free journal for the bounded official profile-provider replacement canary.
-- Provider inputs and storage identifiers remain only in Apify. The temporary ordered-set
-- HMAC is cleared only after every terminal source and canary storage is verified absent.

CREATE TABLE public.analysis_v2_profile_provider_canary_experiments (
    source_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    canary_version TEXT NOT NULL DEFAULT 'profile-fallback-replacement-canary-v1',
    ordered_set_hmac VARCHAR(64),
    source_run_count INTEGER NOT NULL DEFAULT 8,
    candidate_count INTEGER NOT NULL DEFAULT 15,
    unique_candidate_count INTEGER NOT NULL DEFAULT 15,
    public_candidate_count INTEGER NOT NULL DEFAULT 15,
    incomplete_candidate_count INTEGER NOT NULL DEFAULT 15,
    unavailable_candidate_count INTEGER NOT NULL DEFAULT 0,
    primary_success_candidate_count INTEGER NOT NULL DEFAULT 0,
    critical_candidate_count INTEGER NOT NULL DEFAULT 3,
    state TEXT NOT NULL DEFAULT 'active',
    terminal_reason TEXT,
    rep2_approval_deadline_at TIMESTAMP WITH TIME ZONE,
    source_kvs_cleanup_state TEXT NOT NULL DEFAULT 'pending',
    source_dataset_cleanup_state TEXT NOT NULL DEFAULT 'pending',
    source_request_queue_cleanup_state TEXT NOT NULL DEFAULT 'pending',
    source_kvs_cleaned_at TIMESTAMP WITH TIME ZONE,
    source_dataset_cleaned_at TIMESTAMP WITH TIME ZONE,
    source_request_queue_cleaned_at TIMESTAMP WITH TIME ZONE,
    cleanup_claim_token UUID,
    cleanup_claimed_at TIMESTAMP WITH TIME ZONE,
    cleanup_lease_expires_at TIMESTAMP WITH TIME ZONE,
    hmac_cleared_at TIMESTAMP WITH TIME ZONE,
    experiment_terminal_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (source_request_id, canary_version),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_version_check CHECK (
        canary_version = 'profile-fallback-replacement-canary-v1'
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_counts_check CHECK (
        source_run_count = 8
        AND candidate_count = 15
        AND unique_candidate_count = 15
        AND public_candidate_count = 15
        AND incomplete_candidate_count = 15
        AND unavailable_candidate_count = 0
        AND primary_success_candidate_count = 0
        AND critical_candidate_count = 3
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_state_value_check CHECK (
        state IN ('active', 'awaiting_repetition_2', 'terminalizing', 'experiment_terminal')
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_reason_check CHECK (
        terminal_reason IS NULL OR terminal_reason IN (
            'strict_failure', 'verified_no_run', 'completed',
            'aborted_by_operator', 'expired_waiting_for_repetition'
        )
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_hmac_check CHECK (
        ordered_set_hmac IS NULL OR ordered_set_hmac ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_cleanup_value_check CHECK (
        source_kvs_cleanup_state IN ('pending', 'verified_absent')
        AND source_dataset_cleanup_state IN ('pending', 'verified_absent')
        AND source_request_queue_cleanup_state IN ('pending', 'verified_absent')
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_cleanup_time_check CHECK (
        (source_kvs_cleanup_state = 'pending') = (source_kvs_cleaned_at IS NULL)
        AND (source_dataset_cleanup_state = 'pending') = (source_dataset_cleaned_at IS NULL)
        AND (source_request_queue_cleanup_state = 'pending') =
            (source_request_queue_cleaned_at IS NULL)
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_lifecycle_check CHECK (
        (
            state = 'active'
            AND ordered_set_hmac IS NOT NULL
            AND terminal_reason IS NULL
            AND rep2_approval_deadline_at IS NULL
            AND cleanup_claim_token IS NULL
            AND cleanup_claimed_at IS NULL
            AND cleanup_lease_expires_at IS NULL
            AND hmac_cleared_at IS NULL
            AND experiment_terminal_at IS NULL
        ) OR (
            state = 'awaiting_repetition_2'
            AND ordered_set_hmac IS NOT NULL
            AND terminal_reason IS NULL
            AND rep2_approval_deadline_at IS NOT NULL
            AND cleanup_claim_token IS NULL
            AND cleanup_claimed_at IS NULL
            AND cleanup_lease_expires_at IS NULL
            AND hmac_cleared_at IS NULL
            AND experiment_terminal_at IS NULL
        ) OR (
            state = 'terminalizing'
            AND ordered_set_hmac IS NOT NULL
            AND terminal_reason IS NOT NULL
            AND cleanup_claim_token IS NOT NULL
            AND cleanup_claimed_at IS NOT NULL
            AND cleanup_lease_expires_at IS NOT NULL
            AND hmac_cleared_at IS NULL
            AND experiment_terminal_at IS NULL
        ) OR (
            state = 'experiment_terminal'
            AND ordered_set_hmac IS NULL
            AND terminal_reason IS NOT NULL
            AND source_kvs_cleanup_state = 'verified_absent'
            AND source_dataset_cleanup_state = 'verified_absent'
            AND source_request_queue_cleanup_state = 'verified_absent'
            AND hmac_cleared_at IS NOT NULL
            AND experiment_terminal_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_experiment_time_check CHECK (
        updated_at >= created_at
        AND (rep2_approval_deadline_at IS NULL OR rep2_approval_deadline_at >= created_at)
        AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at >= created_at)
        AND (cleanup_lease_expires_at IS NULL OR cleanup_lease_expires_at >= cleanup_claimed_at)
        AND (hmac_cleared_at IS NULL OR hmac_cleared_at >= created_at)
        AND (experiment_terminal_at IS NULL OR experiment_terminal_at >= hmac_cleared_at)
    )
);

CREATE TABLE public.analysis_v2_profile_provider_canary_runs (
    source_request_id UUID NOT NULL,
    canary_version TEXT NOT NULL DEFAULT 'profile-fallback-replacement-canary-v1',
    repetition INTEGER NOT NULL,
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-scraper',
    actor_build TEXT NOT NULL DEFAULT '0.0.692',
    input_contract_version INTEGER NOT NULL DEFAULT 1,
    output_contract_version INTEGER NOT NULL DEFAULT 1,
    credential_slot TEXT NOT NULL DEFAULT 'primary',
    requested_count INTEGER NOT NULL DEFAULT 15,
    max_charge_usd NUMERIC(18, 12) NOT NULL DEFAULT 0.050000000000,
    reservation_token UUID NOT NULL,
    state TEXT NOT NULL DEFAULT 'starting',
    run_id VARCHAR(64),
    terminal_count INTEGER,
    success_count INTEGER,
    unavailable_count INTEGER,
    incomplete_count INTEGER,
    other_failure_count INTEGER,
    critical_success_count INTEGER,
    latency_ms INTEGER,
    build_verified BOOLEAN,
    restricted_access_verified BOOLEAN NOT NULL,
    gate_passed BOOLEAN,
    actual_usage_usd NUMERIC(18, 12),
    cost_status TEXT NOT NULL DEFAULT 'conservative',
    kvs_cleanup_state TEXT NOT NULL DEFAULT 'pending',
    dataset_cleanup_state TEXT NOT NULL DEFAULT 'pending',
    request_queue_cleanup_state TEXT NOT NULL DEFAULT 'pending',
    kvs_cleaned_at TIMESTAMP WITH TIME ZONE,
    dataset_cleaned_at TIMESTAMP WITH TIME ZONE,
    request_queue_cleaned_at TIMESTAMP WITH TIME ZONE,
    resolution_kind TEXT NOT NULL DEFAULT 'none',
    resolution_evidence_hash VARCHAR(64),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    ambiguous_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    cleanup_completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (source_request_id, canary_version, repetition),
    FOREIGN KEY (source_request_id, canary_version)
        REFERENCES public.analysis_v2_profile_provider_canary_experiments(
            source_request_id, canary_version
        ) ON DELETE CASCADE,
    UNIQUE (reservation_token),
    UNIQUE (run_id),
    CONSTRAINT analysis_v2_profile_provider_canary_run_identity_check CHECK (
        canary_version = 'profile-fallback-replacement-canary-v1'
        AND repetition IN (1, 2)
        AND actor_id = 'apify/instagram-scraper'
        AND actor_build = '0.0.692'
        AND input_contract_version = 1
        AND output_contract_version = 1
        AND credential_slot = 'primary'
        AND requested_count = 15
        AND max_charge_usd = 0.050000000000
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_state_value_check CHECK (
        state IN ('starting', 'ambiguous', 'running', 'succeeded', 'failed', 'verified_no_run')
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_cost_check CHECK (
        cost_status IN ('actual', 'conservative', 'unknown')
        AND (actual_usage_usd IS NULL OR actual_usage_usd BETWEEN 0 AND 1.000000000000)
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_id_check CHECK (
        run_id IS NULL OR run_id ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_counts_check CHECK (
        (terminal_count IS NULL OR terminal_count = 15)
        AND (success_count IS NULL OR success_count BETWEEN 0 AND 15)
        AND (unavailable_count IS NULL OR unavailable_count BETWEEN 0 AND 15)
        AND (incomplete_count IS NULL OR incomplete_count BETWEEN 0 AND 15)
        AND (other_failure_count IS NULL OR other_failure_count BETWEEN 0 AND 15)
        AND (critical_success_count IS NULL OR critical_success_count BETWEEN 0 AND 3)
        AND (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 300000)
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_cleanup_value_check CHECK (
        kvs_cleanup_state IN ('pending', 'verified_absent', 'not_applicable')
        AND dataset_cleanup_state IN ('pending', 'verified_absent', 'not_applicable')
        AND request_queue_cleanup_state IN ('pending', 'verified_absent', 'not_applicable')
        AND (kvs_cleanup_state = 'pending') = (kvs_cleaned_at IS NULL)
        AND (dataset_cleanup_state = 'pending') = (dataset_cleaned_at IS NULL)
        AND (request_queue_cleanup_state = 'pending') = (request_queue_cleaned_at IS NULL)
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_resolution_check CHECK (
        resolution_kind IN ('none', 'adopted_run', 'verified_no_run')
        AND (resolution_evidence_hash IS NULL OR resolution_evidence_hash ~ '^[0-9a-f]{64}$')
        AND (
            (resolution_kind = 'none' AND resolution_evidence_hash IS NULL AND resolved_at IS NULL)
            OR (resolution_kind <> 'none' AND resolution_evidence_hash IS NOT NULL AND resolved_at IS NOT NULL)
        )
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_lifecycle_check CHECK (
        (
            state = 'starting' AND run_id IS NULL AND run_started_at IS NULL
            AND ambiguous_at IS NULL AND terminalized_at IS NULL
            AND terminal_count IS NULL AND actual_usage_usd IS NULL
            AND cost_status = 'conservative' AND gate_passed IS NULL
        ) OR (
            state = 'ambiguous' AND run_id IS NULL AND run_started_at IS NULL
            AND ambiguous_at IS NOT NULL AND terminalized_at IS NULL
            AND terminal_count IS NULL AND actual_usage_usd IS NULL
            AND cost_status = 'unknown' AND gate_passed IS NULL
        ) OR (
            state = 'running' AND run_id IS NOT NULL AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL AND terminal_count IS NULL
            AND actual_usage_usd IS NULL AND cost_status = 'conservative'
            AND gate_passed IS NULL
        ) OR (
            state IN ('succeeded', 'failed') AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL AND terminalized_at IS NOT NULL
            AND terminal_count = 15 AND success_count IS NOT NULL
            AND unavailable_count IS NOT NULL AND incomplete_count IS NOT NULL
            AND other_failure_count IS NOT NULL AND critical_success_count IS NOT NULL
            AND success_count + unavailable_count + incomplete_count + other_failure_count = 15
            AND latency_ms IS NOT NULL AND build_verified IS NOT NULL
            AND (
                (actual_usage_usd IS NULL AND usage_reconciled_at IS NULL
                    AND cost_status = 'conservative' AND cleanup_completed_at IS NULL)
                OR (actual_usage_usd IS NOT NULL AND usage_reconciled_at IS NOT NULL
                    AND cost_status = 'actual')
            )
        ) OR (
            state = 'verified_no_run' AND run_id IS NULL AND run_started_at IS NULL
            AND ambiguous_at IS NOT NULL AND terminalized_at IS NOT NULL
            AND terminal_count IS NULL AND success_count IS NULL
            AND actual_usage_usd = 0 AND usage_reconciled_at IS NOT NULL
            AND cost_status = 'actual' AND gate_passed = FALSE
            AND kvs_cleanup_state = 'not_applicable'
            AND dataset_cleanup_state = 'not_applicable'
            AND request_queue_cleanup_state = 'not_applicable'
            AND cleanup_completed_at IS NOT NULL
            AND resolution_kind = 'verified_no_run'
        )
    ),
    CONSTRAINT analysis_v2_profile_provider_canary_run_time_check CHECK (
        updated_at >= reserved_at
        AND (run_started_at IS NULL OR run_started_at >= reserved_at - INTERVAL '1 minute')
        AND (ambiguous_at IS NULL OR ambiguous_at >= reserved_at)
        AND (resolved_at IS NULL OR resolved_at >= reserved_at)
        AND (terminalized_at IS NULL OR terminalized_at >= reserved_at)
        AND (usage_reconciled_at IS NULL OR usage_reconciled_at >= terminalized_at)
        AND (cleanup_completed_at IS NULL OR cleanup_completed_at >= usage_reconciled_at)
    )
);

CREATE INDEX idx_analysis_v2_profile_provider_canary_expiry
    ON public.analysis_v2_profile_provider_canary_experiments(
        state, rep2_approval_deadline_at, cleanup_lease_expires_at, source_request_id
    );

ALTER TABLE public.analysis_v2_profile_provider_canary_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_provider_canary_experiments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_profile_provider_canary_experiments
    FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.analysis_v2_profile_provider_canary_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_provider_canary_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_profile_provider_canary_runs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_profile_provider_canary_experiment_json(
    p_experiment public.analysis_v2_profile_provider_canary_experiments
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'sourceRequestId', p_experiment.source_request_id,
        'canaryVersion', p_experiment.canary_version,
        'orderedSetHmac', p_experiment.ordered_set_hmac,
        'sourceRunCount', p_experiment.source_run_count,
        'candidateCount', p_experiment.candidate_count,
        'uniqueCandidateCount', p_experiment.unique_candidate_count,
        'publicCandidateCount', p_experiment.public_candidate_count,
        'incompleteCandidateCount', p_experiment.incomplete_candidate_count,
        'unavailableCandidateCount', p_experiment.unavailable_candidate_count,
        'primarySuccessCandidateCount', p_experiment.primary_success_candidate_count,
        'criticalCandidateCount', p_experiment.critical_candidate_count,
        'state', p_experiment.state,
        'terminalReason', p_experiment.terminal_reason,
        'rep2ApprovalDeadlineAt', p_experiment.rep2_approval_deadline_at,
        'sourceKvsCleanupState', p_experiment.source_kvs_cleanup_state,
        'sourceDatasetCleanupState', p_experiment.source_dataset_cleanup_state,
        'sourceRequestQueueCleanupState', p_experiment.source_request_queue_cleanup_state,
        'sourceKvsCleanedAt', p_experiment.source_kvs_cleaned_at,
        'sourceDatasetCleanedAt', p_experiment.source_dataset_cleaned_at,
        'sourceRequestQueueCleanedAt', p_experiment.source_request_queue_cleaned_at,
        'cleanupClaimToken', p_experiment.cleanup_claim_token,
        'cleanupClaimedAt', p_experiment.cleanup_claimed_at,
        'cleanupLeaseExpiresAt', p_experiment.cleanup_lease_expires_at,
        'hmacClearedAt', p_experiment.hmac_cleared_at,
        'experimentTerminalAt', p_experiment.experiment_terminal_at,
        'createdAt', p_experiment.created_at,
        'updatedAt', p_experiment.updated_at
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_profile_provider_canary_run_json(
    p_run public.analysis_v2_profile_provider_canary_runs
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'sourceRequestId', p_run.source_request_id,
        'canaryVersion', p_run.canary_version,
        'repetition', p_run.repetition,
        'actorId', p_run.actor_id,
        'actorBuild', p_run.actor_build,
        'inputContractVersion', p_run.input_contract_version,
        'outputContractVersion', p_run.output_contract_version,
        'credentialSlot', p_run.credential_slot,
        'requestedCount', p_run.requested_count,
        'maxChargeUsd', p_run.max_charge_usd,
        'reservationToken', p_run.reservation_token,
        'state', p_run.state,
        'runId', p_run.run_id,
        'terminalCount', p_run.terminal_count,
        'successCount', p_run.success_count,
        'unavailableCount', p_run.unavailable_count,
        'incompleteCount', p_run.incomplete_count,
        'otherFailureCount', p_run.other_failure_count,
        'criticalSuccessCount', p_run.critical_success_count,
        'latencyMs', p_run.latency_ms,
        'buildVerified', p_run.build_verified,
        'restrictedAccessVerified', p_run.restricted_access_verified,
        'gatePassed', p_run.gate_passed,
        'actualUsageUsd', p_run.actual_usage_usd,
        'costStatus', p_run.cost_status,
        'kvsCleanupState', p_run.kvs_cleanup_state,
        'datasetCleanupState', p_run.dataset_cleanup_state,
        'requestQueueCleanupState', p_run.request_queue_cleanup_state,
        'kvsCleanedAt', p_run.kvs_cleaned_at,
        'datasetCleanedAt', p_run.dataset_cleaned_at,
        'requestQueueCleanedAt', p_run.request_queue_cleaned_at,
        'resolutionKind', p_run.resolution_kind,
        'resolutionEvidenceHash', p_run.resolution_evidence_hash,
        'reservedAt', p_run.reserved_at,
        'runStartedAt', p_run.run_started_at,
        'ambiguousAt', p_run.ambiguous_at,
        'resolvedAt', p_run.resolved_at,
        'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at,
        'cleanupCompletedAt', p_run.cleanup_completed_at,
        'updatedAt', p_run.updated_at
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_provider_canary_experiment_json(
    public.analysis_v2_profile_provider_canary_experiments
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_profile_provider_canary_run_json(
    public.analysis_v2_profile_provider_canary_runs
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_provider_canary_source(
    p_source_request_id UUID,
    p_owner_id UUID,
    p_owner_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_runs JSONB;
    v_run_count INTEGER;
BEGIN
    IF p_source_request_id IS NULL OR p_owner_id IS NULL
       OR p_owner_email IS NULL OR pg_catalog.btrim(p_owner_email) = ''
       OR pg_catalog.char_length(p_owner_email) > 255 THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_SOURCE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    JOIN public.users AS owner ON owner.id = analysis_request.user_id
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = analysis_request.id
    JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption
      ON entitlement_consumption.request_id = analysis_request.id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = entitlement_consumption.preflight_id
    WHERE analysis_request.id = p_source_request_id
      AND analysis_request.user_id = p_owner_id
      AND pg_catalog.lower(owner.email) = pg_catalog.lower(p_owner_email)
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status = 'failed'
      AND analysis_request.plan_access_mode_snapshot = 'test_entitlement'
      AND analysis_request.selected_plan_id_snapshot = entitlement_consumption.selected_plan_id
      AND analysis_request.preflight_id = preflight.id
      AND analysis_request.test_entitlement_jti_hash = execution_policy.entitlement_jti_hash
      AND analysis_request.test_entitlement_jti_hash = entitlement_consumption.entitlement_jti_hash
      AND analysis_request.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(analysis_request.id::TEXT, '-', ''), 1, 20
      )
      AND execution_policy.mode = 'test_operation_split'
      AND execution_policy.policy_version = 'authorized-free-e2e-v1'
      AND execution_policy.target_instagram_id = '0_min._.00'
      AND entitlement_consumption.user_id = analysis_request.user_id
      AND entitlement_consumption.selected_plan_id = 'standard'
      AND preflight.user_id = analysis_request.user_id
      AND preflight.consumed_request_id = analysis_request.id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
      );
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER,
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'jobKey', provider_run.job_key,
            'operationKey', provider_run.operation_key,
            'status', provider_run.status,
            'runId', provider_run.run_id,
            'actorId', provider_run.actor_id,
            'credentialSlot', provider_run.credential_slot,
            'maxChargeUsd', provider_run.max_charge_usd
        ) ORDER BY provider_run.job_key)
    INTO v_run_count, v_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = provider_run.request_id
    WHERE provider_run.request_id = p_source_request_id
      AND provider_run.status = 'succeeded'
      AND provider_run.run_id ~ '^[A-Za-z0-9]{8,64}$'
      AND provider_run.actor_id = 'apify/instagram-profile-scraper'
      AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'
      AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
      AND execution_policy.operation_slot_map->>'profile-fallback' = provider_run.credential_slot
    HAVING pg_catalog.count(*) = 8
       AND pg_catalog.count(DISTINCT provider_run.job_key) = 8
       AND pg_catalog.count(DISTINCT provider_run.run_id) = 8;
    IF v_run_count IS DISTINCT FROM 8 THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'request', pg_catalog.jsonb_build_object(
            'sourceRequestId', v_request.id,
            'userId', v_request.user_id,
            'ownerEmail', p_owner_email,
            'targetInstagramId', '0_min._.00',
            'pipelineVersion', v_request.pipeline_version,
            'status', v_request.status
        ),
        'runs', v_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_provider_canary_source(
    UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_provider_canary_source(
    UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_provider_canary_experiment(
    p_source_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1';
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_provider_canary_experiment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_provider_canary_experiment(UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_provider_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_provider_canary_run(UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_provider_canary_run(UUID, INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_source_run_count INTEGER,
    p_candidate_count INTEGER,
    p_unique_candidate_count INTEGER,
    p_public_candidate_count INTEGER,
    p_incomplete_candidate_count INTEGER,
    p_unavailable_candidate_count INTEGER,
    p_primary_success_candidate_count INTEGER,
    p_critical_candidate_count INTEGER,
    p_ordered_set_hmac TEXT,
    p_restricted_access_verified BOOLEAN,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_source_count INTEGER;
    v_source_job_count INTEGER;
    v_source_run_id_count INTEGER;
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_previous public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_source_run_count IS DISTINCT FROM 8
       OR p_candidate_count IS DISTINCT FROM 15
       OR p_unique_candidate_count IS DISTINCT FROM 15
       OR p_public_candidate_count IS DISTINCT FROM 15
       OR p_incomplete_candidate_count IS DISTINCT FROM 15
       OR p_unavailable_candidate_count IS DISTINCT FROM 0
       OR p_primary_success_candidate_count IS DISTINCT FROM 0
       OR p_critical_candidate_count IS DISTINCT FROM 3
       OR p_ordered_set_hmac IS NULL OR p_ordered_set_hmac !~ '^[0-9a-f]{64}$'
       OR p_restricted_access_verified IS DISTINCT FROM TRUE
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    -- APP_BOUND_SOURCE_REPLAY_PROOF: source storage is not readable from SQL. The caller
    -- derives this bounded aggregate proof from the zero-start replay; SQL stores no raw rows.

    SELECT pg_catalog.count(*)::INTEGER,
        pg_catalog.count(DISTINCT provider_run.job_key)::INTEGER,
        pg_catalog.count(DISTINCT provider_run.run_id)::INTEGER
    INTO v_source_count, v_source_job_count, v_source_run_id_count
    FROM public.analysis_requests AS analysis_request
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = analysis_request.id
    JOIN public.analysis_v2_test_entitlement_consumptions AS entitlement_consumption
      ON entitlement_consumption.request_id = analysis_request.id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = entitlement_consumption.preflight_id
    JOIN public.analysis_v2_provider_runs AS provider_run
      ON provider_run.request_id = analysis_request.id
    WHERE analysis_request.id = p_source_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status = 'failed'
      AND analysis_request.plan_access_mode_snapshot = 'test_entitlement'
      AND analysis_request.selected_plan_id_snapshot = entitlement_consumption.selected_plan_id
      AND analysis_request.preflight_id = preflight.id
      AND analysis_request.test_entitlement_jti_hash = execution_policy.entitlement_jti_hash
      AND analysis_request.test_entitlement_jti_hash = entitlement_consumption.entitlement_jti_hash
      AND analysis_request.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(analysis_request.id::TEXT, '-', ''), 1, 20
      )
      AND execution_policy.mode = 'test_operation_split'
      AND execution_policy.policy_version = 'authorized-free-e2e-v1'
      AND execution_policy.target_instagram_id = '0_min._.00'
      AND entitlement_consumption.user_id = analysis_request.user_id
      AND entitlement_consumption.selected_plan_id = 'standard'
      AND preflight.user_id = analysis_request.user_id
      AND preflight.consumed_request_id = analysis_request.id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
      )
      AND provider_run.status = 'succeeded'
      AND provider_run.run_id ~ '^[A-Za-z0-9]{8,64}$'
      AND provider_run.actor_id = 'apify/instagram-profile-scraper'
      AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'
      AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
      AND execution_policy.operation_slot_map->>'profile-fallback' = provider_run.credential_slot;
    IF v_source_count IS DISTINCT FROM 8
       OR v_source_job_count IS DISTINCT FROM 8
       OR v_source_run_id_count IS DISTINCT FROM 8 THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;

    IF NOT FOUND THEN
        IF p_repetition <> 1 THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
        INSERT INTO public.analysis_v2_profile_provider_canary_experiments (
            source_request_id, ordered_set_hmac, source_run_count, candidate_count,
            unique_candidate_count, public_candidate_count, incomplete_candidate_count,
            unavailable_candidate_count, primary_success_candidate_count,
            critical_candidate_count
        ) VALUES (
            p_source_request_id, p_ordered_set_hmac, p_source_run_count, p_candidate_count,
            p_unique_candidate_count, p_public_candidate_count, p_incomplete_candidate_count,
            p_unavailable_candidate_count, p_primary_success_candidate_count,
            p_critical_candidate_count
        )
        RETURNING * INTO v_experiment;
    ELSIF v_experiment.ordered_set_hmac IS DISTINCT FROM p_ordered_set_hmac THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_HMAC_CONFLICT', ERRCODE = 'P0001';
    ELSIF v_experiment.source_run_count IS DISTINCT FROM p_source_run_count
       OR v_experiment.candidate_count IS DISTINCT FROM p_candidate_count
       OR v_experiment.unique_candidate_count IS DISTINCT FROM p_unique_candidate_count
       OR v_experiment.public_candidate_count IS DISTINCT FROM p_public_candidate_count
       OR v_experiment.incomplete_candidate_count IS DISTINCT FROM p_incomplete_candidate_count
       OR v_experiment.unavailable_candidate_count IS DISTINCT FROM p_unavailable_candidate_count
       OR v_experiment.primary_success_candidate_count IS DISTINCT FROM p_primary_success_candidate_count
       OR v_experiment.critical_candidate_count IS DISTINCT FROM p_critical_candidate_count THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF FOUND THEN
        IF v_run.actor_id IS DISTINCT FROM 'apify/instagram-scraper'
           OR v_run.actor_build IS DISTINCT FROM '0.0.692'
           OR v_run.credential_slot IS DISTINCT FROM 'primary'
           OR v_run.requested_count IS DISTINCT FROM 15
           OR v_run.max_charge_usd IS DISTINCT FROM 0.050000000000
           OR (v_run.state IN ('starting', 'ambiguous', 'running')
               AND v_run.restricted_access_verified IS DISTINCT FROM TRUE) THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE,
            'experiment', public.analysis_v2_profile_provider_canary_experiment_json(v_experiment),
            'run', public.analysis_v2_profile_provider_canary_run_json(v_run)
        );
    END IF;

    IF p_repetition = 2 THEN
        SELECT canary_run.* INTO v_previous
        FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.repetition = 1
        FOR UPDATE;
        IF NOT FOUND
           OR v_experiment.state IS DISTINCT FROM 'awaiting_repetition_2'
           OR v_experiment.rep2_approval_deadline_at IS NULL
           OR v_experiment.rep2_approval_deadline_at <= v_now
           OR v_previous.state IS DISTINCT FROM 'succeeded'
           OR v_previous.gate_passed IS DISTINCT FROM TRUE
           OR v_previous.cost_status IS DISTINCT FROM 'actual'
           OR v_previous.cleanup_completed_at IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
        SET state = 'active', rep2_approval_deadline_at = NULL, updated_at = v_now
        WHERE experiment.source_request_id = p_source_request_id
          AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
        RETURNING * INTO v_experiment;
    ELSIF v_experiment.state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_profile_provider_canary_runs (
        source_request_id, repetition, reservation_token, restricted_access_verified
    ) VALUES (p_source_request_id, p_repetition, p_reservation_token, TRUE)
    RETURNING * INTO v_run;
    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE,
        'experiment', public.analysis_v2_profile_provider_canary_experiment_json(v_experiment),
        'run', public.analysis_v2_profile_provider_canary_run_json(v_run)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    TEXT, BOOLEAN, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    TEXT, BOOLEAN, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_provider_canary_run_started(
    p_source_request_id UUID,
    p_repetition INTEGER,
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
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state = 'starting' THEN
        UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
        SET state = 'running', run_id = p_run_id, run_started_at = v_now, updated_at = v_now
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.repetition = p_repetition
        RETURNING canary_run.* INTO v_run;
    ELSIF v_run.state = 'ambiguous' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    ELSIF v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_provider_canary_run_started(
    UUID, INTEGER, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_provider_canary_run_started(
    UUID, INTEGER, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state = 'starting' THEN
        UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
        SET state = 'ambiguous', cost_status = 'unknown', ambiguous_at = v_now, updated_at = v_now
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.repetition = p_repetition
        RETURNING canary_run.* INTO v_run;
    ELSIF v_run.state <> 'ambiguous' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
    UUID, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
    UUID, INTEGER, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.terminalize_analysis_v2_profile_provider_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_terminal_count INTEGER,
    p_success_count INTEGER,
    p_unavailable_count INTEGER,
    p_incomplete_count INTEGER,
    p_other_failure_count INTEGER,
    p_critical_success_count INTEGER,
    p_latency_ms INTEGER,
    p_build_verified BOOLEAN,
    p_restricted_access_verified BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_state TEXT;
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_terminal_count IS DISTINCT FROM 15
       OR p_success_count NOT BETWEEN 0 AND 15
       OR p_unavailable_count NOT BETWEEN 0 AND 15
       OR p_incomplete_count NOT BETWEEN 0 AND 15
       OR p_other_failure_count NOT BETWEEN 0 AND 15
       OR p_critical_success_count NOT BETWEEN 0 AND 3
       OR p_success_count + p_unavailable_count + p_incomplete_count + p_other_failure_count <> 15
       OR p_latency_ms NOT BETWEEN 0 AND 300000
       OR p_build_verified IS NULL
       OR p_restricted_access_verified IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    v_state := CASE WHEN p_success_count = 15 AND p_unavailable_count = 0
        AND p_incomplete_count = 0 AND p_other_failure_count = 0
        AND p_critical_success_count = 3 AND p_latency_ms <= 60000
        AND p_build_verified THEN 'succeeded' ELSE 'failed' END;

    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state IN ('succeeded', 'failed') THEN
        IF v_run.state IS DISTINCT FROM v_state OR v_run.terminal_count IS DISTINCT FROM 15
           OR v_run.success_count IS DISTINCT FROM p_success_count
           OR v_run.unavailable_count IS DISTINCT FROM p_unavailable_count
           OR v_run.incomplete_count IS DISTINCT FROM p_incomplete_count
           OR v_run.other_failure_count IS DISTINCT FROM p_other_failure_count
           OR v_run.critical_success_count IS DISTINCT FROM p_critical_success_count
           OR v_run.latency_ms IS DISTINCT FROM p_latency_ms
           OR v_run.build_verified IS DISTINCT FROM p_build_verified
           OR v_run.restricted_access_verified IS DISTINCT FROM p_restricted_access_verified THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_TERMINAL_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
    END IF;
    IF v_run.state <> 'running' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
    SET state = v_state, terminal_count = 15,
        success_count = p_success_count, unavailable_count = p_unavailable_count,
        incomplete_count = p_incomplete_count, other_failure_count = p_other_failure_count,
        critical_success_count = p_critical_success_count, latency_ms = p_latency_ms,
        build_verified = p_build_verified,
        restricted_access_verified = p_restricted_access_verified,
        terminalized_at = v_now, updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN
) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_analysis_v2_profile_provider_canary_run_usage(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_actual_usage_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_actual_usage_usd IS NULL OR p_actual_usage_usd < 0
       OR p_actual_usage_usd > 1.000000000000
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state NOT IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.actual_usage_usd IS NOT NULL THEN
        IF v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd
           OR v_run.cost_status IS DISTINCT FROM 'actual' THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_RECONCILIATION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
    END IF;
    UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
    SET actual_usage_usd = p_actual_usage_usd, cost_status = 'actual',
        usage_reconciled_at = v_now, updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_analysis_v2_profile_provider_canary_run_usage(
    UUID, INTEGER, UUID, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_analysis_v2_profile_provider_canary_run_usage(
    UUID, INTEGER, UUID, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_profile_provider_canary_run_storage_clean(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_storage TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
    v_gate BOOLEAN;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_storage NOT IN ('kvs', 'dataset', 'request_queue') THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state NOT IN ('succeeded', 'failed')
       OR v_run.cost_status IS DISTINCT FROM 'actual'
       OR v_run.usage_reconciled_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
    SET kvs_cleanup_state = CASE WHEN p_storage = 'kvs' THEN 'verified_absent'
            ELSE canary_run.kvs_cleanup_state END,
        kvs_cleaned_at = CASE WHEN p_storage = 'kvs' THEN COALESCE(canary_run.kvs_cleaned_at, v_now)
            ELSE canary_run.kvs_cleaned_at END,
        dataset_cleanup_state = CASE WHEN p_storage = 'dataset' THEN 'verified_absent'
            ELSE canary_run.dataset_cleanup_state END,
        dataset_cleaned_at = CASE WHEN p_storage = 'dataset' THEN COALESCE(canary_run.dataset_cleaned_at, v_now)
            ELSE canary_run.dataset_cleaned_at END,
        request_queue_cleanup_state = CASE WHEN p_storage = 'request_queue' THEN 'verified_absent'
            ELSE canary_run.request_queue_cleanup_state END,
        request_queue_cleaned_at = CASE WHEN p_storage = 'request_queue'
            THEN COALESCE(canary_run.request_queue_cleaned_at, v_now)
            ELSE canary_run.request_queue_cleaned_at END,
        updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;

    IF v_run.kvs_cleanup_state = 'verified_absent'
       AND v_run.dataset_cleanup_state = 'verified_absent'
       AND v_run.request_queue_cleanup_state = 'verified_absent' THEN
        v_gate := v_run.state = 'succeeded'
            AND v_run.success_count = 15
            AND v_run.unavailable_count = 0
            AND v_run.incomplete_count = 0
            AND v_run.other_failure_count = 0
            AND v_run.critical_success_count = 3
            AND v_run.latency_ms <= 60000
            AND v_run.build_verified
            AND v_run.restricted_access_verified
            AND v_run.actual_usage_usd <= 0.050000000000;
        UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
        SET gate_passed = v_gate, cleanup_completed_at = COALESCE(cleanup_completed_at, v_now),
            updated_at = v_now
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.repetition = p_repetition
        RETURNING canary_run.* INTO v_run;

        IF p_repetition = 1 AND v_gate THEN
            UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
            SET state = 'awaiting_repetition_2',
                rep2_approval_deadline_at = v_run.terminalized_at + INTERVAL '1 hour',
                updated_at = v_now
            WHERE experiment.source_request_id = p_source_request_id
              AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
              AND experiment.state = 'active';
        END IF;
    END IF;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_profile_provider_canary_run_storage_clean(
    UUID, INTEGER, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_profile_provider_canary_run_storage_clean(
    UUID, INTEGER, UUID, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_profile_provider_canary_adopt_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_actor_id TEXT,
    p_actor_build TEXT,
    p_credential_slot TEXT,
    p_run_started_at TIMESTAMP WITH TIME ZONE,
    p_input_hmac TEXT,
    p_evidence_reference_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-scraper'
       OR p_actor_build IS DISTINCT FROM '0.0.692'
       OR p_credential_slot IS DISTINCT FROM 'primary'
       OR p_run_started_at IS NULL
       OR p_input_hmac !~ '^[0-9a-f]{64}$'
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_experiment.ordered_set_hmac IS DISTINCT FROM p_input_hmac
       OR p_run_started_at < v_run.reserved_at - INTERVAL '1 minute'
       OR p_run_started_at > v_run.ambiguous_at + INTERVAL '1 minute' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state = 'running' AND v_run.resolution_kind = 'adopted_run' THEN
        IF v_run.run_id IS DISTINCT FROM p_run_id
           OR v_run.resolution_evidence_hash IS DISTINCT FROM p_evidence_reference_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
    END IF;
    IF v_run.state <> 'ambiguous' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
    SET state = 'running', run_id = p_run_id, run_started_at = p_run_started_at,
        cost_status = 'conservative', resolution_kind = 'adopted_run',
        resolution_evidence_hash = p_evidence_reference_hash,
        resolved_at = v_now, updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_profile_provider_canary_adopt_run(
    UUID, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_profile_provider_canary_no_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_evidence_reference_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_run public.analysis_v2_profile_provider_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state = 'verified_no_run' THEN
        IF v_run.resolution_kind IS DISTINCT FROM 'verified_no_run'
           OR v_run.resolution_evidence_hash IS DISTINCT FROM p_evidence_reference_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF (v_experiment.state = 'terminalizing'
                AND v_experiment.terminal_reason = 'verified_no_run')
           OR (v_experiment.state = 'experiment_terminal'
                AND v_experiment.terminal_reason = 'verified_no_run') THEN
            RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_run.state <> 'ambiguous' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_experiment.state <> 'active'
       OR v_experiment.ordered_set_hmac IS NULL
       OR v_experiment.terminal_reason IS NOT NULL
       OR v_experiment.cleanup_claim_token IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_repetition = 1 AND EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS later_run
        WHERE later_run.source_request_id = p_source_request_id
          AND later_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND later_run.repetition = 2
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_repetition = 2 AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS first_run
        WHERE first_run.source_request_id = p_source_request_id
          AND first_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND first_run.repetition = 1
          AND first_run.state = 'succeeded'
          AND first_run.gate_passed = TRUE
          AND first_run.cost_status = 'actual'
          AND first_run.cleanup_completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_profile_provider_canary_runs AS canary_run
    SET state = 'verified_no_run', cost_status = 'actual', actual_usage_usd = 0,
        gate_passed = FALSE, kvs_cleanup_state = 'not_applicable',
        dataset_cleanup_state = 'not_applicable', request_queue_cleanup_state = 'not_applicable',
        kvs_cleaned_at = v_now, dataset_cleaned_at = v_now, request_queue_cleaned_at = v_now,
        resolution_kind = 'verified_no_run', resolution_evidence_hash = p_evidence_reference_hash,
        resolved_at = v_now, terminalized_at = v_now, usage_reconciled_at = v_now,
        cleanup_completed_at = v_now, updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;
    UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
    SET state = 'terminalizing', terminal_reason = 'verified_no_run',
        rep2_approval_deadline_at = NULL,
        cleanup_claim_token = p_reservation_token,
        cleanup_claimed_at = v_now, cleanup_lease_expires_at = v_now,
        updated_at = v_now
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
      AND experiment.state = 'active'
    RETURNING experiment.* INTO v_experiment;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RESOLUTION_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_provider_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_profile_provider_canary_no_run(
    UUID, INTEGER, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_analysis_v2_profile_provider_canary_terminalization(
    p_source_request_id UUID,
    p_terminal_reason TEXT,
    p_cleanup_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_terminal_run_count INTEGER;
    v_unready_run_count INTEGER;
BEGIN
    IF p_source_request_id IS NULL OR p_cleanup_claim_token IS NULL
       OR p_terminal_reason NOT IN (
            'strict_failure', 'verified_no_run', 'completed',
            'aborted_by_operator', 'expired_waiting_for_repetition'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_experiment.state = 'experiment_terminal' THEN
        IF v_experiment.terminal_reason IS DISTINCT FROM p_terminal_reason THEN
            RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
    END IF;
    IF v_experiment.state = 'terminalizing'
       AND v_experiment.cleanup_claim_token = p_cleanup_claim_token
       AND v_experiment.terminal_reason = p_terminal_reason THEN
        RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
    END IF;
    IF v_experiment.state = 'terminalizing'
       AND v_experiment.terminal_reason IS DISTINCT FROM p_terminal_reason THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_experiment.state = 'terminalizing'
       AND v_experiment.cleanup_lease_expires_at > v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER,
        pg_catalog.count(*) FILTER (WHERE
            canary_run.state IN ('starting', 'ambiguous', 'running')
            OR (canary_run.state IN ('succeeded', 'failed') AND (
                canary_run.cost_status <> 'actual' OR canary_run.cleanup_completed_at IS NULL
            ))
        )::INTEGER
    INTO v_terminal_run_count, v_unready_run_count
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1';
    IF v_terminal_run_count < 1 OR v_unready_run_count <> 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF p_terminal_reason = 'aborted_by_operator' AND (
        v_experiment.state <> 'awaiting_repetition_2'
        OR EXISTS (
            SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
            WHERE canary_run.source_request_id = p_source_request_id
              AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
              AND canary_run.repetition = 2
        )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_terminal_reason = 'verified_no_run' AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.state = 'verified_no_run'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_terminal_reason = 'completed' AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.repetition = 2
          AND canary_run.gate_passed = TRUE
          AND canary_run.cleanup_completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_terminal_reason = 'strict_failure' AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
          AND canary_run.gate_passed = FALSE
          AND canary_run.cleanup_completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_terminal_reason = 'expired_waiting_for_repetition' THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
    SET state = 'terminalizing', terminal_reason = p_terminal_reason,
        cleanup_claim_token = p_cleanup_claim_token, cleanup_claimed_at = v_now,
        cleanup_lease_expires_at = v_now + INTERVAL '10 minutes', updated_at = v_now
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    RETURNING experiment.* INTO v_experiment;
    RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_analysis_v2_profile_provider_canary_terminalization(
    UUID, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_analysis_v2_profile_provider_canary_terminalization(
    UUID, TEXT, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
    p_limit INTEGER DEFAULT 4,
    p_cleanup_claim_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_claimed JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 16
       OR p_cleanup_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_INVALID', ERRCODE = 'P0001';
    END IF;
    WITH candidate_keys AS MATERIALIZED (
        SELECT experiment.source_request_id, experiment.canary_version
        FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
        WHERE (
            experiment.state = 'awaiting_repetition_2'
            AND experiment.rep2_approval_deadline_at <= v_now
            AND NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
                WHERE canary_run.source_request_id = experiment.source_request_id
                  AND canary_run.canary_version = experiment.canary_version
                  AND canary_run.repetition = 2
            )
        ) OR (
            experiment.state = 'terminalizing'
            AND experiment.cleanup_lease_expires_at <= v_now
        )
        ORDER BY experiment.rep2_approval_deadline_at, experiment.source_request_id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    ), claimed AS (
        UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
        SET state = 'terminalizing',
            terminal_reason = CASE
                WHEN experiment.state = 'awaiting_repetition_2'
                    THEN 'expired_waiting_for_repetition'
                ELSE experiment.terminal_reason END,
            cleanup_claim_token = p_cleanup_claim_token,
            cleanup_claimed_at = v_now,
            cleanup_lease_expires_at = v_now + INTERVAL '10 minutes',
            updated_at = v_now
        FROM candidate_keys AS candidate
        WHERE experiment.source_request_id = candidate.source_request_id
          AND experiment.canary_version = candidate.canary_version
        RETURNING experiment.*
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(
        public.analysis_v2_profile_provider_canary_experiment_json(claimed)
        ORDER BY claimed.source_request_id
    ), '[]'::JSONB)
    INTO v_claimed FROM claimed;
    RETURN v_claimed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
    INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
    INTEGER, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_provider_canary_cleanup_inventory(
    p_source_request_id UUID,
    p_cleanup_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
    v_source_runs JSONB;
    v_canary_runs JSONB;
    v_source_count INTEGER;
    v_source_job_count INTEGER;
    v_source_run_id_count INTEGER;
BEGIN
    IF p_source_request_id IS NULL OR p_cleanup_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    IF NOT FOUND OR v_experiment.state IS DISTINCT FROM 'terminalizing'
       OR v_experiment.cleanup_claim_token IS DISTINCT FROM p_cleanup_claim_token THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.count(*)::INTEGER,
        pg_catalog.count(DISTINCT provider_run.job_key)::INTEGER,
        pg_catalog.count(DISTINCT provider_run.run_id)::INTEGER,
        COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'runId', provider_run.run_id,
            'credentialSlot', provider_run.credential_slot
        ) ORDER BY provider_run.job_key), '[]'::JSONB)
    INTO v_source_count, v_source_job_count, v_source_run_id_count, v_source_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    JOIN public.analysis_v2_provider_execution_policies AS execution_policy
      ON execution_policy.request_id = provider_run.request_id
    WHERE provider_run.request_id = p_source_request_id
      AND provider_run.status = 'succeeded'
      AND provider_run.run_id ~ '^[A-Za-z0-9]{8,64}$'
      AND provider_run.actor_id = 'apify/instagram-profile-scraper'
      AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'
      AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
      AND execution_policy.mode = 'test_operation_split'
      AND execution_policy.policy_version = 'authorized-free-e2e-v1'
      AND execution_policy.operation_slot_map->>'profile-fallback' = provider_run.credential_slot;
    IF v_source_count IS DISTINCT FROM 8
       OR v_source_job_count IS DISTINCT FROM 8
       OR v_source_run_id_count IS DISTINCT FROM 8 THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_INVENTORY_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'repetition', canary_run.repetition,
        'runId', canary_run.run_id,
        'credentialSlot', canary_run.credential_slot,
        'reservationToken', canary_run.reservation_token
    ) ORDER BY canary_run.repetition), '[]'::JSONB)
    INTO v_canary_runs
    FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
      AND canary_run.run_id IS NOT NULL;

    RETURN pg_catalog.jsonb_build_object(
        'sourceRequestId', p_source_request_id,
        'sourceRuns', v_source_runs,
        'canaryRuns', v_canary_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_provider_canary_cleanup_inventory(
    UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_provider_canary_cleanup_inventory(
    UUID, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_profile_provider_canary_source_storage_clean(
    p_source_request_id UUID,
    p_cleanup_claim_token UUID,
    p_storage TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_cleanup_claim_token IS NULL
       OR p_storage NOT IN ('kvs', 'dataset', 'request_queue') THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    IF NOT FOUND OR v_experiment.state IS DISTINCT FROM 'terminalizing'
       OR v_experiment.cleanup_claim_token IS DISTINCT FROM p_cleanup_claim_token THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
    SET source_kvs_cleanup_state = CASE WHEN p_storage = 'kvs' THEN 'verified_absent'
            ELSE experiment.source_kvs_cleanup_state END,
        source_kvs_cleaned_at = CASE WHEN p_storage = 'kvs'
            THEN COALESCE(experiment.source_kvs_cleaned_at, v_now)
            ELSE experiment.source_kvs_cleaned_at END,
        source_dataset_cleanup_state = CASE WHEN p_storage = 'dataset' THEN 'verified_absent'
            ELSE experiment.source_dataset_cleanup_state END,
        source_dataset_cleaned_at = CASE WHEN p_storage = 'dataset'
            THEN COALESCE(experiment.source_dataset_cleaned_at, v_now)
            ELSE experiment.source_dataset_cleaned_at END,
        source_request_queue_cleanup_state = CASE WHEN p_storage = 'request_queue'
            THEN 'verified_absent' ELSE experiment.source_request_queue_cleanup_state END,
        source_request_queue_cleaned_at = CASE WHEN p_storage = 'request_queue'
            THEN COALESCE(experiment.source_request_queue_cleaned_at, v_now)
            ELSE experiment.source_request_queue_cleaned_at END,
        updated_at = v_now
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    RETURNING experiment.* INTO v_experiment;
    RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_profile_provider_canary_source_storage_clean(
    UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_profile_provider_canary_source_storage_clean(
    UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_profile_provider_canary_cleanup(
    p_source_request_id UUID,
    p_cleanup_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_experiment public.analysis_v2_profile_provider_canary_experiments%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_cleanup_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT experiment.* INTO v_experiment
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_experiment.state = 'experiment_terminal'
       AND v_experiment.cleanup_claim_token = p_cleanup_claim_token THEN
        RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
    END IF;
    IF v_experiment.state IS DISTINCT FROM 'terminalizing'
       OR v_experiment.cleanup_claim_token IS DISTINCT FROM p_cleanup_claim_token THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_experiment.source_kvs_cleanup_state IS DISTINCT FROM 'verified_absent'
       OR v_experiment.source_dataset_cleanup_state IS DISTINCT FROM 'verified_absent'
       OR v_experiment.source_request_queue_cleanup_state IS DISTINCT FROM 'verified_absent'
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_profile_provider_canary_runs AS canary_run
            WHERE canary_run.source_request_id = p_source_request_id
              AND canary_run.canary_version = 'profile-fallback-replacement-canary-v1'
              AND (
                    canary_run.state IN ('starting', 'ambiguous', 'running')
                    OR (canary_run.run_id IS NOT NULL AND (
                        canary_run.cost_status <> 'actual'
                        OR canary_run.cleanup_completed_at IS NULL
                        OR canary_run.kvs_cleanup_state <> 'verified_absent'
                        OR canary_run.dataset_cleanup_state <> 'verified_absent'
                        OR canary_run.request_queue_cleanup_state <> 'verified_absent'
                    ))
              )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'PROFILE_PROVIDER_CANARY_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_profile_provider_canary_experiments AS experiment
    SET state = 'experiment_terminal', ordered_set_hmac = NULL,
        hmac_cleared_at = v_now, experiment_terminal_at = v_now, updated_at = v_now
    WHERE experiment.source_request_id = p_source_request_id
      AND experiment.canary_version = 'profile-fallback-replacement-canary-v1'
    RETURNING experiment.* INTO v_experiment;
    RETURN public.analysis_v2_profile_provider_canary_experiment_json(v_experiment);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_profile_provider_canary_cleanup(
    UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_profile_provider_canary_cleanup(
    UUID, UUID
) TO service_role;
