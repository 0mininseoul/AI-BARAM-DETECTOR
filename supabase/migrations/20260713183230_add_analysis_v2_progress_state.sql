CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_track(p_track JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_track IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_track) = 'object'
       AND p_track ?& ARRAY['state', 'stageCode', 'done', 'total', 'progressBp']
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_track) AS track_key(value)
            WHERE track_key.value <> ALL (
                ARRAY['state', 'stageCode', 'done', 'total', 'progressBp']
            )
       )
       AND p_track->>'state' IN ('pending', 'running', 'completed', 'failed')
       AND p_track->>'stageCode' ~ '^[A-Z][A-Z0-9_]{0,63}$'
       AND pg_catalog.jsonb_typeof(p_track->'done') = 'number'
       AND p_track->>'done' ~ '^(0|[1-9][0-9]{0,6})$'
       AND (p_track->>'done')::INTEGER BETWEEN 0 AND 1000000
       AND pg_catalog.jsonb_typeof(p_track->'total') = 'number'
       AND p_track->>'total' ~ '^(0|[1-9][0-9]{0,6})$'
       AND (p_track->>'total')::INTEGER BETWEEN 0 AND 1000000
       AND (p_track->>'done')::INTEGER <= (p_track->>'total')::INTEGER
       AND pg_catalog.jsonb_typeof(p_track->'progressBp') = 'number'
       AND p_track->>'progressBp' ~ '^(0|[1-9][0-9]{0,4})$'
       AND (p_track->>'progressBp')::INTEGER = CASE
            WHEN (p_track->>'total')::INTEGER = 0 THEN 0
            ELSE pg_catalog.floor(
                (p_track->>'done')::NUMERIC * 10000
                / (p_track->>'total')::NUMERIC
            )::INTEGER
       END
       AND (p_track->>'progressBp')::INTEGER BETWEEN 0 AND 10000
       AND (p_track->>'state' <> 'pending' OR (p_track->>'done')::INTEGER = 0)
       AND (
            p_track->>'state' <> 'completed'
            OR (p_track->>'done')::INTEGER = (p_track->>'total')::INTEGER
       );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_tracks(p_tracks JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_tracks IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_tracks) = 'object'
       AND p_tracks ?& ARRAY['relationshipAi', 'interactions', 'finalization']
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_tracks) AS track_key(value)
            WHERE track_key.value <> ALL (
                ARRAY['relationshipAi', 'interactions', 'finalization']
            )
       )
       AND public.analysis_v2_valid_progress_track(p_tracks->'relationshipAi')
       AND public.analysis_v2_valid_progress_track(p_tracks->'interactions')
       AND public.analysis_v2_valid_progress_track(p_tracks->'finalization');
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_active_profile(p_profile JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_profile IS NULL OR (
        pg_catalog.jsonb_typeof(p_profile) = 'object'
        AND p_profile ?& ARRAY['maskedUsername', 'imageUrl']
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_profile) AS profile_key(value)
            WHERE profile_key.value <> ALL (ARRAY['maskedUsername', 'imageUrl'])
        )
        AND pg_catalog.jsonb_typeof(p_profile->'maskedUsername') = 'string'
        AND p_profile->>'maskedUsername' ~ '^[A-Za-z0-9._]*\*[A-Za-z0-9._*]*$'
        AND pg_catalog.char_length(p_profile->>'maskedUsername') BETWEEN 1 AND 30
        AND (
            pg_catalog.jsonb_typeof(p_profile->'imageUrl') = 'null'
            OR (
                pg_catalog.jsonb_typeof(p_profile->'imageUrl') = 'string'
                AND pg_catalog.char_length(p_profile->>'imageUrl') BETWEEN 1 AND 2048
                AND p_profile->>'imageUrl' LIKE '/api/image-proxy?%'
            )
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_eta(p_eta JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_eta IS NULL OR (
        pg_catalog.jsonb_typeof(p_eta) = 'object'
        AND p_eta ?& ARRAY['lowSeconds', 'highSeconds']
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_eta) AS eta_key(value)
            WHERE eta_key.value <> ALL (ARRAY['lowSeconds', 'highSeconds'])
        )
        AND pg_catalog.jsonb_typeof(p_eta->'lowSeconds') = 'number'
        AND p_eta->>'lowSeconds' ~ '^(0|[1-9][0-9]{0,3})$'
        AND (p_eta->>'lowSeconds')::INTEGER BETWEEN 0 AND 3600
        AND pg_catalog.jsonb_typeof(p_eta->'highSeconds') = 'number'
        AND p_eta->>'highSeconds' ~ '^(0|[1-9][0-9]{0,3})$'
        AND (p_eta->>'highSeconds')::INTEGER BETWEEN 0 AND 3600
        AND (p_eta->>'lowSeconds')::INTEGER <= (p_eta->>'highSeconds')::INTEGER
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_event(p_event JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_event IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_event) = 'object'
       AND p_event ?& ARRAY['state', 'eventCode', 'copyCode', 'aggregateCount']
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_event) AS event_key(value)
            WHERE event_key.value <> ALL (
                ARRAY['state', 'eventCode', 'copyCode', 'aggregateCount']
            )
       )
       AND p_event->>'state' IN ('provisional', 'confirmed', 'corrected')
       AND p_event->>'eventCode' IN (
            'TARGET_PROFILE_READY',
            'RELATIONSHIP_PROGRESS',
            'PROFILE_SCREENED',
            'POTENTIAL_HIGH_RISK_FOUND',
            'FINDING_CORRECTED',
            'FINDING_CONFIRMED',
            'ANALYSIS_COMPLETED'
       )
       AND p_event->>'copyCode' ~ '^[A-Z][A-Z0-9_]{0,63}$'
       AND (
            pg_catalog.jsonb_typeof(p_event->'aggregateCount') = 'null'
            OR (
                pg_catalog.jsonb_typeof(p_event->'aggregateCount') = 'number'
                AND p_event->>'aggregateCount' ~ '^(0|[1-9][0-9]{0,4})$'
                AND (p_event->>'aggregateCount')::INTEGER BETWEEN 0 AND 10000
            )
       )
       AND (
            p_event->>'eventCode' <> 'POTENTIAL_HIGH_RISK_FOUND'
            OR p_event->>'state' = 'provisional'
       )
       AND (
            p_event->>'eventCode' <> 'FINDING_CORRECTED'
            OR p_event->>'state' = 'corrected'
       )
       AND (
            p_event->>'eventCode' NOT IN ('FINDING_CONFIRMED', 'ANALYSIS_COMPLETED')
            OR p_event->>'state' = 'confirmed'
       );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_calculate_progress_bp(
    p_tracks JSONB,
    p_status TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN p_status = 'completed' THEN 10000
        ELSE LEAST(
            9999,
            pg_catalog.floor(
                7200::DOUBLE PRECISION * CASE
                    WHEN (p_tracks->'relationshipAi'->>'total')::INTEGER = 0 THEN 0
                    ELSE (p_tracks->'relationshipAi'->>'done')::DOUBLE PRECISION
                        / (p_tracks->'relationshipAi'->>'total')::DOUBLE PRECISION
                END
                + 1700::DOUBLE PRECISION * CASE
                    WHEN (p_tracks->'interactions'->>'total')::INTEGER = 0 THEN 0
                    ELSE (p_tracks->'interactions'->>'done')::DOUBLE PRECISION
                        / (p_tracks->'interactions'->>'total')::DOUBLE PRECISION
                END
                + 1100::DOUBLE PRECISION * CASE
                    WHEN (p_tracks->'finalization'->>'total')::INTEGER = 0 THEN 0
                    ELSE (p_tracks->'finalization'->>'done')::DOUBLE PRECISION
                        / (p_tracks->'finalization'->>'total')::DOUBLE PRECISION
                END
            )::INTEGER
        )
    END;
$$;

CREATE TABLE public.analysis_progress_state (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    status TEXT NOT NULL,
    progress_bp INTEGER NOT NULL,
    background_processing BOOLEAN NOT NULL,
    tracks JSONB NOT NULL,
    active_profile JSONB,
    eta_range JSONB,
    last_event_seq BIGINT NOT NULL,
    snapshot_fingerprint VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_progress_state_revision_check CHECK (
        revision BETWEEN 1 AND 9007199254740991
    ),
    CONSTRAINT analysis_progress_state_status_check CHECK (
        status IN ('queued', 'processing', 'completed', 'failed', 'upgrade_required')
    ),
    CONSTRAINT analysis_progress_state_bp_check CHECK (
        progress_bp BETWEEN public.analysis_v2_calculate_progress_bp(tracks, status)
            AND CASE WHEN status = 'completed' THEN 10000 ELSE 9999 END
    ),
    CONSTRAINT analysis_progress_state_background_check CHECK (
        (status IN ('queued', 'processing') AND background_processing)
        OR (status IN ('completed', 'failed', 'upgrade_required') AND NOT background_processing)
    ),
    CONSTRAINT analysis_progress_state_tracks_check CHECK (
        public.analysis_v2_valid_progress_tracks(tracks)
    ),
    CONSTRAINT analysis_progress_state_completed_check CHECK (
        status <> 'completed'
        OR (
            progress_bp = 10000
            AND tracks->'relationshipAi'->>'state' = 'completed'
            AND tracks->'interactions'->>'state' = 'completed'
            AND tracks->'finalization'->>'state' = 'completed'
        )
    ),
    CONSTRAINT analysis_progress_state_terminal_transient_check CHECK (
        status NOT IN ('completed', 'failed', 'upgrade_required')
        OR (active_profile IS NULL AND eta_range IS NULL)
    ),
    CONSTRAINT analysis_progress_state_active_profile_check CHECK (
        public.analysis_v2_valid_progress_active_profile(active_profile)
    ),
    CONSTRAINT analysis_progress_state_eta_check CHECK (
        public.analysis_v2_valid_progress_eta(eta_range)
    ),
    CONSTRAINT analysis_progress_state_sequence_check CHECK (
        last_event_seq BETWEEN 0 AND 9007199254740991
    ),
    CONSTRAINT analysis_progress_state_fingerprint_check CHECK (
        snapshot_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_progress_state_time_check CHECK (updated_at >= created_at)
);

CREATE TABLE public.analysis_progress_events (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    event_key VARCHAR(64) NOT NULL,
    revision BIGINT NOT NULL,
    snapshot_fingerprint VARCHAR(64) NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    event_state TEXT NOT NULL,
    event_code TEXT NOT NULL,
    copy_code TEXT NOT NULL,
    aggregate_count INTEGER,
    PRIMARY KEY (request_id, seq),
    CONSTRAINT analysis_progress_events_key_unique UNIQUE (request_id, event_key),
    CONSTRAINT analysis_progress_events_seq_check CHECK (
        seq BETWEEN 1 AND 9007199254740991
    ),
    CONSTRAINT analysis_progress_events_revision_check CHECK (
        revision BETWEEN 1 AND 9007199254740991
    ),
    CONSTRAINT analysis_progress_events_key_check CHECK (event_key ~ '^[a-f0-9]{64}$'),
    CONSTRAINT analysis_progress_events_fingerprint_check CHECK (
        snapshot_fingerprint ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_progress_events_state_check CHECK (
        event_state IN ('provisional', 'confirmed', 'corrected')
    ),
    CONSTRAINT analysis_progress_events_code_check CHECK (
        event_code IN (
            'TARGET_PROFILE_READY',
            'RELATIONSHIP_PROGRESS',
            'PROFILE_SCREENED',
            'POTENTIAL_HIGH_RISK_FOUND',
            'FINDING_CORRECTED',
            'FINDING_CONFIRMED',
            'ANALYSIS_COMPLETED'
        )
    ),
    CONSTRAINT analysis_progress_events_copy_check CHECK (
        copy_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    CONSTRAINT analysis_progress_events_aggregate_check CHECK (
        aggregate_count IS NULL OR aggregate_count BETWEEN 0 AND 10000
    )
);

CREATE INDEX idx_analysis_progress_events_request_time
    ON public.analysis_progress_events(request_id, occurred_at DESC);

ALTER TABLE public.analysis_progress_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_progress_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_progress_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_progress_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_progress_state
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_progress_events
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.analysis_progress_state TO authenticated;
GRANT SELECT ON TABLE public.analysis_progress_events TO authenticated;

CREATE POLICY analysis_progress_state_owner_select
    ON public.analysis_progress_state
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = analysis_progress_state.request_id
              AND analysis_request.user_id = (SELECT auth.uid())
        )
    );

CREATE POLICY analysis_progress_events_owner_select
    ON public.analysis_progress_events
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = analysis_progress_events.request_id
              AND analysis_request.user_id = (SELECT auth.uid())
        )
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_progress_track_transition_valid(
    p_previous JSONB,
    p_next JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT (p_next->>'done')::INTEGER >= (p_previous->>'done')::INTEGER
       AND (p_next->>'total')::INTEGER >= (p_previous->>'total')::INTEGER
       AND (p_next->>'progressBp')::INTEGER >= (p_previous->>'progressBp')::INTEGER
       AND (
            (p_previous->>'state' = 'pending'
                AND p_next->>'state' IN ('pending', 'running', 'completed', 'failed'))
            OR (p_previous->>'state' = 'running'
                AND p_next->>'state' IN ('running', 'completed', 'failed'))
            OR p_previous->>'state' IN ('completed', 'failed')
       )
       AND (
            p_previous->>'state' NOT IN ('completed', 'failed')
            OR p_next = p_previous
       );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_progress_snapshot_json(
    p_state public.analysis_progress_state
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'requestId', p_state.request_id,
        'revision', p_state.revision,
        'status', p_state.status,
        'progressBp', p_state.progress_bp,
        'backgroundProcessing', p_state.background_processing,
        'tracks', p_state.tracks,
        'activeProfile', p_state.active_profile,
        'etaRange', p_state.eta_range,
        'lastEventSeq', p_state.last_event_seq
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_progress_event_json(
    p_event public.analysis_progress_events
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'requestId', p_event.request_id,
        'seq', p_event.seq,
        'revision', p_event.revision,
        'occurredAt', p_event.occurred_at,
        'state', p_event.event_state,
        'eventCode', p_event.event_code,
        'copyCode', p_event.copy_code,
        'aggregateCount', p_event.aggregate_count
    );
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_progress(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_status TEXT,
    p_progress_bp INTEGER,
    p_background_processing BOOLEAN,
    p_tracks JSONB,
    p_active_profile JSONB,
    p_eta_range JSONB,
    p_snapshot_fingerprint TEXT,
    p_event JSONB DEFAULT NULL,
    p_event_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_state public.analysis_progress_state%ROWTYPE;
    v_event public.analysis_progress_events%ROWTYPE;
    v_existing_event public.analysis_progress_events%ROWTYPE;
    v_calculated_progress INTEGER;
    v_stored_progress INTEGER;
    v_payload_changed BOOLEAN;
    v_event_new BOOLEAN := FALSE;
    v_advanced BOOLEAN;
    v_next_revision BIGINT;
    v_next_sequence BIGINT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_status IS NULL
       OR p_status NOT IN ('queued', 'processing', 'completed', 'failed', 'upgrade_required')
       OR p_progress_bp IS NULL
       OR p_background_processing IS NULL
       OR NOT public.analysis_v2_valid_progress_tracks(p_tracks)
       OR NOT public.analysis_v2_valid_progress_active_profile(p_active_profile)
       OR NOT public.analysis_v2_valid_progress_eta(p_eta_range)
       OR p_snapshot_fingerprint IS NULL
       OR p_snapshot_fingerprint !~ '^[a-f0-9]{64}$'
       OR ((p_event IS NULL) IS DISTINCT FROM (p_event_key IS NULL))
       OR (p_event IS NOT NULL AND (
            NOT public.analysis_v2_valid_progress_event(p_event)
            OR p_event_key !~ '^[a-f0-9]{64}$'
       ))
       OR (
            p_status IN ('queued', 'processing')
            AND NOT p_background_processing
       )
       OR (
            p_status IN ('completed', 'failed', 'upgrade_required')
            AND (
                p_background_processing
                OR p_active_profile IS NOT NULL
                OR p_eta_range IS NOT NULL
            )
       )
       OR (
            p_event->>'eventCode' = 'ANALYSIS_COMPLETED'
            AND p_status <> 'completed'
       )
       OR (
            p_status IN ('failed', 'upgrade_required')
            AND p_event IS NOT NULL
       )
       OR (
            p_status = 'completed'
            AND (
                p_event->>'eventCode' IS DISTINCT FROM 'ANALYSIS_COMPLETED'
                OR p_tracks->'relationshipAi'->>'state' IS DISTINCT FROM 'completed'
                OR p_tracks->'interactions'->>'state' IS DISTINCT FROM 'completed'
                OR p_tracks->'finalization'->>'state' IS DISTINCT FROM 'completed'
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    v_calculated_progress := public.analysis_v2_calculate_progress_bp(p_tracks, p_status);
    IF p_progress_bp IS DISTINCT FROM v_calculated_progress THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    -- Refresh after lock acquisition so a lease cannot remain live only at function entry.
    v_now := pg_catalog.clock_timestamp();
    IF v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT progress_state.*
    INTO v_state
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        IF p_job_key <> 'coordinator:bootstrap' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_NOT_READY', ERRCODE = 'P0001';
        END IF;
        v_payload_changed := TRUE;
        v_stored_progress := v_calculated_progress;
        v_next_revision := 1;
        v_next_sequence := CASE WHEN p_event IS NULL THEN 0 ELSE 1 END;
        v_event_new := p_event IS NOT NULL;

        INSERT INTO public.analysis_progress_state (
            request_id,
            revision,
            status,
            progress_bp,
            background_processing,
            tracks,
            active_profile,
            eta_range,
            last_event_seq,
            snapshot_fingerprint,
            created_at,
            updated_at
        ) VALUES (
            p_request_id,
            v_next_revision,
            p_status,
            v_stored_progress,
            p_background_processing,
            p_tracks,
            p_active_profile,
            p_eta_range,
            v_next_sequence,
            p_snapshot_fingerprint,
            v_now,
            v_now
        ) RETURNING * INTO v_state;
    ELSE
        IF v_state.status IN ('completed', 'failed', 'upgrade_required')
           AND p_status IS DISTINCT FROM v_state.status THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_REGRESSION', ERRCODE = 'P0001';
        END IF;
        IF v_state.status = 'processing' AND p_status = 'queued' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_REGRESSION', ERRCODE = 'P0001';
        END IF;
        IF NOT public.analysis_v2_progress_track_transition_valid(
                v_state.tracks->'relationshipAi', p_tracks->'relationshipAi'
            )
           OR NOT public.analysis_v2_progress_track_transition_valid(
                v_state.tracks->'interactions', p_tracks->'interactions'
            )
           OR NOT public.analysis_v2_progress_track_transition_valid(
                v_state.tracks->'finalization', p_tracks->'finalization'
            ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_REGRESSION', ERRCODE = 'P0001';
        END IF;

        v_payload_changed := v_state.status IS DISTINCT FROM p_status
            OR v_state.background_processing IS DISTINCT FROM p_background_processing
            OR v_state.tracks IS DISTINCT FROM p_tracks
            OR v_state.active_profile IS DISTINCT FROM p_active_profile
            OR v_state.eta_range IS DISTINCT FROM p_eta_range;
        IF v_payload_changed = (v_state.snapshot_fingerprint = p_snapshot_fingerprint) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_CONFLICT', ERRCODE = 'P0001';
        END IF;

        IF p_event IS NOT NULL THEN
            SELECT progress_event.*
            INTO v_existing_event
            FROM public.analysis_progress_events AS progress_event
            WHERE progress_event.request_id = p_request_id
              AND progress_event.event_key = p_event_key
            FOR UPDATE;
            IF FOUND THEN
                IF v_existing_event.snapshot_fingerprint IS DISTINCT FROM p_snapshot_fingerprint
                   OR v_existing_event.event_state IS DISTINCT FROM p_event->>'state'
                   OR v_existing_event.event_code IS DISTINCT FROM p_event->>'eventCode'
                   OR v_existing_event.copy_code IS DISTINCT FROM p_event->>'copyCode'
                   OR v_existing_event.aggregate_count IS DISTINCT FROM (CASE
                        WHEN pg_catalog.jsonb_typeof(p_event->'aggregateCount') = 'null' THEN NULL
                        ELSE (p_event->>'aggregateCount')::INTEGER
                   END) THEN
                    RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_EVENT_CONFLICT', ERRCODE = 'P0001';
                END IF;
            ELSE
                v_event_new := TRUE;
            END IF;
        END IF;

        v_advanced := v_payload_changed OR v_event_new;
        v_next_revision := v_state.revision + CASE WHEN v_advanced THEN 1 ELSE 0 END;
        v_next_sequence := v_state.last_event_seq + CASE WHEN v_event_new THEN 1 ELSE 0 END;
        IF v_next_revision > 9007199254740991 OR v_next_sequence > 9007199254740991 THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_CONFLICT', ERRCODE = 'P0001';
        END IF;
        v_stored_progress := GREATEST(v_state.progress_bp, v_calculated_progress);

        IF v_advanced THEN
            UPDATE public.analysis_progress_state AS progress_state
            SET revision = v_next_revision,
                status = p_status,
                progress_bp = v_stored_progress,
                background_processing = p_background_processing,
                tracks = p_tracks,
                active_profile = p_active_profile,
                eta_range = p_eta_range,
                last_event_seq = v_next_sequence,
                snapshot_fingerprint = p_snapshot_fingerprint,
                updated_at = v_now
            WHERE progress_state.request_id = p_request_id
            RETURNING * INTO v_state;
        END IF;
    END IF;

    IF v_event_new THEN
        INSERT INTO public.analysis_progress_events (
            request_id,
            seq,
            event_key,
            revision,
            snapshot_fingerprint,
            occurred_at,
            event_state,
            event_code,
            copy_code,
            aggregate_count
        ) VALUES (
            p_request_id,
            v_state.last_event_seq,
            p_event_key,
            v_state.revision,
            p_snapshot_fingerprint,
            v_now,
            p_event->>'state',
            p_event->>'eventCode',
            p_event->>'copyCode',
            CASE
                WHEN pg_catalog.jsonb_typeof(p_event->'aggregateCount') = 'null' THEN NULL
                ELSE (p_event->>'aggregateCount')::INTEGER
            END
        ) RETURNING * INTO v_event;
    ELSIF p_event IS NOT NULL THEN
        v_event := v_existing_event;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'snapshot', public.analysis_v2_progress_snapshot_json(v_state),
        'event', CASE
            WHEN p_event IS NULL THEN NULL
            ELSE public.analysis_v2_progress_event_json(v_event)
        END,
        'advanced', COALESCE(v_payload_changed, FALSE) OR v_event_new
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_progress(
    p_request_id UUID,
    p_user_id UUID,
    p_after_sequence BIGINT DEFAULT 0,
    p_event_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_state public.analysis_progress_state%ROWTYPE;
    v_events JSONB;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_after_sequence IS NULL
       OR p_after_sequence < 0
       OR p_after_sequence > 9007199254740991
       OR p_event_limit IS NULL
       OR p_event_limit < 1
       OR p_event_limit > 200 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.user_id = p_user_id
          AND analysis_request.pipeline_version = 'v2'
    ) THEN
        RETURN NULL;
    END IF;

    SELECT progress_state.*
    INTO v_state
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(page.event_json ORDER BY page.seq), '[]'::JSONB)
    INTO v_events
    FROM (
        SELECT
            progress_event.seq,
            public.analysis_v2_progress_event_json(progress_event) AS event_json
        FROM public.analysis_progress_events AS progress_event
        WHERE progress_event.request_id = p_request_id
          AND progress_event.seq > p_after_sequence
        ORDER BY progress_event.seq
        LIMIT p_event_limit
    ) AS page;

    RETURN pg_catalog.jsonb_build_object(
        'snapshot', public.analysis_v2_progress_snapshot_json(v_state),
        'events', v_events
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_progress_track(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_progress_tracks(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_progress_active_profile(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_progress_eta(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_progress_event(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_calculate_progress_bp(JSONB, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_track_transition_valid(JSONB, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_snapshot_json(public.analysis_progress_state)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_event_json(public.analysis_progress_events)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_progress(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_progress(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_progress(UUID, UUID, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_progress(UUID, UUID, BIGINT, INTEGER)
    TO service_role;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'analysis_progress_state'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.analysis_progress_state;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime'
    ) AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'analysis_progress_events'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.analysis_progress_events;
    END IF;
END;
$$;

COMMENT ON TABLE public.analysis_progress_state IS
    'Owner-readable, sanitized V2 progress snapshot; mutations require a fenced worker RPC.';
COMMENT ON TABLE public.analysis_progress_events IS
    'Owner-readable, sanitized, append-only V2 progress events with contiguous sequence numbers.';
COMMENT ON FUNCTION public.checkpoint_analysis_v2_progress(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) IS
    'Idempotently advances sanitized progress and one deterministic event under an exact live job lease.';
