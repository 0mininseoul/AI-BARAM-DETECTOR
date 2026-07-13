-- Short-lived, service-only rich state needed to resume AI/scoring workers without re-fetching
-- Instagram media or losing the exact evidence used by a predecessor.
CREATE TABLE public.analysis_v2_ai_scoring_stage_checkpoints (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    stage_kind VARCHAR(32) NOT NULL CHECK (stage_kind IN (
        'profile_ai_batch', 'primary_join', 'screening', 'reverse_likes',
        'partner_safety', 'final_score', 'narrative'
    )),
    batch_key INTEGER NOT NULL CHECK (batch_key BETWEEN -1 AND 100000),
    producer_job_key VARCHAR(160) NOT NULL,
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    revision SMALLINT NOT NULL DEFAULT 1 CHECK (revision = 1),
    item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 1200),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    payload JSONB NOT NULL CHECK (pg_catalog.jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, stage_kind, batch_key),
    CONSTRAINT analysis_v2_ai_scoring_stage_batch_check CHECK (
        (stage_kind = 'profile_ai_batch' AND batch_key >= 0)
        OR (stage_kind <> 'profile_ai_batch' AND batch_key = -1)
    )
);

ALTER TABLE public.analysis_v2_ai_scoring_stage_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_ai_scoring_stage_checkpoints FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_ai_scoring_stage_checkpoints
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_scoring_stage_envelope(
    p_row public.analysis_v2_ai_scoring_stage_checkpoints
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'stageKind', p_row.stage_kind,
        'batch', CASE WHEN p_row.batch_key = -1 THEN NULL ELSE p_row.batch_key END,
        'revision', p_row.revision,
        'resultHash', p_row.result_hash,
        'itemCount', p_row.item_count,
        'payload', p_row.payload
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_assert_ai_scoring_stage_producer(
    p_job public.analysis_pipeline_jobs,
    p_stage_kind TEXT,
    p_batch INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
    IF NOT (
        (p_stage_kind = 'profile_ai_batch'
            AND p_batch IS NOT NULL
            AND p_job.job_key = 'track:profile-ai:batch:' || p_batch::TEXT
            AND p_job.track = 'profile_ai'
            AND p_job.kind = 'ai'
            AND p_job.batch = p_batch)
        OR (p_stage_kind = 'primary_join' AND p_batch IS NULL
            AND p_job.job_key = 'coordinator:join:primary-evidence')
        OR (p_stage_kind = 'screening' AND p_batch IS NULL
            AND p_job.job_key = 'coordinator:candidate-screening')
        OR (p_stage_kind = 'reverse_likes' AND p_batch IS NULL
            AND p_job.job_key = 'track:reverse-likes:collect')
        OR (p_stage_kind = 'partner_safety' AND p_batch IS NULL
            AND p_job.job_key = 'track:partner-safety:batch:0')
        OR (p_stage_kind = 'final_score' AND p_batch IS NULL
            AND p_job.job_key = 'coordinator:join:final-score')
        OR (p_stage_kind = 'narrative' AND p_batch IS NULL
            AND p_job.job_key = 'track:narratives:batch:0')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_assert_ai_scoring_stage_consumer(
    p_job public.analysis_pipeline_jobs,
    p_stage_kind TEXT
)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
    IF NOT (CASE p_stage_kind
        WHEN 'profile_ai_batch' THEN p_job.job_key IN (
            'coordinator:join:primary-evidence', 'coordinator:candidate-screening',
            'track:reverse-likes:collect', 'track:partner-safety:batch:0',
            'coordinator:join:final-score', 'track:narratives:batch:0'
        )
        WHEN 'primary_join' THEN p_job.job_key = 'coordinator:candidate-screening'
        WHEN 'screening' THEN p_job.job_key IN (
            'track:reverse-likes:collect', 'track:partner-safety:batch:0',
            'coordinator:join:final-score'
        )
        WHEN 'reverse_likes' THEN p_job.job_key IN (
            'coordinator:join:final-score', 'track:narratives:batch:0'
        )
        WHEN 'partner_safety' THEN p_job.job_key = 'coordinator:join:final-score'
        WHEN 'final_score' THEN p_job.job_key = 'track:narratives:batch:0'
        ELSE FALSE
    END) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_ai_scoring_stage(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_stage_kind TEXT,
    p_batch INTEGER,
    p_item_count INTEGER,
    p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_batch_key INTEGER;
    v_result_hash TEXT;
    v_existing public.analysis_v2_ai_scoring_stage_checkpoints%ROWTYPE;
    v_stored public.analysis_v2_ai_scoring_stage_checkpoints%ROWTYPE;
BEGIN
    IF p_stage_kind NOT IN (
        'profile_ai_batch', 'primary_join', 'screening', 'reverse_likes',
        'partner_safety', 'final_score', 'narrative'
    ) OR p_item_count IS NULL OR p_item_count < 0 OR p_item_count > 1200
      OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
      OR pg_catalog.octet_length(p_payload::TEXT) > 8388608 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    PERFORM public.analysis_v2_assert_ai_scoring_stage_producer(
        v_job, p_stage_kind, p_batch
    );
    v_batch_key := COALESCE(p_batch, -1);
    v_result_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-ai-scoring-stage-v1' || E'\n'
                || p_stage_kind || E'\n' || v_batch_key::TEXT || E'\n'
                || p_payload::TEXT,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    SELECT checkpoint.* INTO v_existing
    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id
      AND checkpoint.stage_kind = p_stage_kind
      AND checkpoint.batch_key = v_batch_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.item_count <> p_item_count
           OR v_existing.result_hash <> v_result_hash
           OR v_existing.payload <> p_payload THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF v_existing.producer_claim_token <> p_claim_token THEN
            UPDATE public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
            SET producer_claim_token = p_claim_token
            WHERE checkpoint.request_id = p_request_id
              AND checkpoint.stage_kind = p_stage_kind
              AND checkpoint.batch_key = v_batch_key
            RETURNING checkpoint.* INTO v_existing;
        END IF;
        RETURN public.analysis_v2_ai_scoring_stage_envelope(v_existing);
    END IF;

    INSERT INTO public.analysis_v2_ai_scoring_stage_checkpoints (
        request_id, stage_kind, batch_key, producer_job_key,
        producer_input_hash, producer_claim_token, item_count, result_hash, payload
    ) VALUES (
        p_request_id, p_stage_kind, v_batch_key, p_job_key,
        p_job_input_hash, p_claim_token, p_item_count, v_result_hash, p_payload
    ) RETURNING * INTO v_stored;
    RETURN public.analysis_v2_ai_scoring_stage_envelope(v_stored);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_ai_scoring_stage(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_stage_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_stored public.analysis_v2_ai_scoring_stage_checkpoints%ROWTYPE;
BEGIN
    IF p_stage_kind = 'profile_ai_batch' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    PERFORM public.analysis_v2_assert_ai_scoring_stage_consumer(v_job, p_stage_kind);
    SELECT checkpoint.* INTO v_stored
    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id
      AND checkpoint.stage_kind = p_stage_kind
      AND checkpoint.batch_key = -1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN public.analysis_v2_ai_scoring_stage_envelope(v_stored);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_ai_stage_batches(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_result JSONB;
BEGIN
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    PERFORM public.analysis_v2_assert_ai_scoring_stage_consumer(
        v_job, 'profile_ai_batch'
    );
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_v2_ai_scoring_stage_envelope(checkpoint)
            ORDER BY checkpoint.batch_key
        ),
        '[]'::JSONB
    ) INTO v_result
    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
    WHERE checkpoint.request_id = p_request_id
      AND checkpoint.stage_kind = 'profile_ai_batch';
    RETURN v_result;
END;
$$;

-- A live downstream worker may consume only the exact, completed profile-fetch checkpoint
-- declared by the DAG. The producer's lease is intentionally not reused after completion.
CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_fetch_for_consumer(
    p_request_id UUID,
    p_consumer_job_key TEXT,
    p_consumer_claim_token UUID,
    p_consumer_input_hash TEXT,
    p_producer_job_key TEXT,
    p_expected_producer_input_hash TEXT,
    p_expected_item_count INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_consumer public.analysis_pipeline_jobs%ROWTYPE;
    v_producer public.analysis_pipeline_jobs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_target_username TEXT;
    v_batch_suffix TEXT;
BEGIN
    IF p_producer_job_key IS NULL
       OR pg_catalog.char_length(p_producer_job_key) NOT BETWEEN 1 AND 160
       OR p_producer_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_expected_item_count IS NULL
       OR p_expected_item_count NOT BETWEEN 1 AND 30
       OR (
            p_expected_producer_input_hash IS NOT NULL
            AND p_expected_producer_input_hash !~ '^[a-f0-9]{64}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_consumer := public.analysis_v2_assert_result_job_fence(
        p_request_id,
        p_consumer_job_key,
        p_consumer_claim_token,
        p_consumer_input_hash
    );

    SELECT job.* INTO v_producer
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_producer_job_key
    FOR SHARE;
    SELECT batch.* INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_producer_job_key
    FOR SHARE;

    IF v_producer.request_id IS NULL
       OR v_producer.status <> 'completed'
       OR v_batch.request_id IS NULL
       OR pg_catalog.cardinality(v_batch.requested_usernames) <> p_expected_item_count
       OR (
            pg_catalog.cardinality(v_batch.frozen_unresolved_usernames) > 0
            AND v_batch.fallback_completed_at IS NULL
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF p_producer_job_key LIKE 'track:profiles:batch:%' THEN
        v_batch_suffix := pg_catalog.substring(
            p_producer_job_key,
            '^track:profiles:batch:([0-9]+)$'
        );
        IF v_batch_suffix IS NULL
           OR p_expected_producer_input_hash IS NULL
           OR v_producer.input_hash IS DISTINCT FROM p_expected_producer_input_hash
           OR v_producer.track <> 'profiles'
           OR v_producer.kind <> 'profile_fetch'
           OR v_producer.batch IS DISTINCT FROM v_batch_suffix::INTEGER
           OR v_consumer.job_key <> 'track:profile-ai:batch:' || v_batch_suffix
           OR v_consumer.track <> 'profile_ai'
           OR v_consumer.kind <> 'ai'
           OR v_consumer.batch IS DISTINCT FROM v_batch_suffix::INTEGER THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    ELSIF p_producer_job_key = 'track:target-evidence:collect' THEN
        SELECT preflight.target_instagram_id INTO v_target_username
        FROM public.analysis_preflights AS preflight
        WHERE preflight.consumed_request_id = p_request_id;
        IF p_expected_producer_input_hash IS NOT NULL
           OR p_expected_item_count <> 1
           OR v_producer.track <> 'target_evidence'
           OR v_producer.kind <> 'collection'
           OR v_batch.requested_usernames <> ARRAY[v_target_username]
           OR v_consumer.job_key NOT IN (
                'coordinator:candidate-screening',
                'track:reverse-likes:collect',
                'track:narratives:batch:0',
                'coordinator:finalize'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(
        p_request_id,
        p_producer_job_key
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_analysis_v2_ai_scoring_stage(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_deleted INTEGER;
BEGIN
    IF p_job_key <> 'coordinator:finalize' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    JOIN public.analysis_requests AS request ON request.id = job.request_id
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.status = 'completed'
      AND job.input_hash = p_job_input_hash
      AND job.completion_token = p_claim_token
      AND request.pipeline_version = 'v2'
      AND request.status = 'completed'
    FOR UPDATE OF job;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints
    WHERE request_id = p_request_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_scoring_stage_envelope(
    public.analysis_v2_ai_scoring_stage_checkpoints
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_assert_ai_scoring_stage_producer(
    public.analysis_pipeline_jobs, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_assert_ai_scoring_stage_consumer(
    public.analysis_pipeline_jobs, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_ai_scoring_stage(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_analysis_v2_ai_scoring_stage(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_ai_stage_batches(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_fetch_for_consumer(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_analysis_v2_ai_scoring_stage(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_ai_scoring_stage(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_ai_scoring_stage(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_ai_stage_batches(
    UUID, TEXT, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_fetch_for_consumer(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_analysis_v2_ai_scoring_stage(
    UUID, TEXT, UUID, TEXT
) TO service_role;
