-- PostgreSQL ARE interval bounds are limited to 255. Length remains bounded by
-- the explicit char_length check, so the character-class repetition must be unbounded.
ALTER TABLE public.analysis_pipeline_jobs
    DROP CONSTRAINT analysis_pipeline_jobs_task_name_check,
    ADD CONSTRAINT analysis_pipeline_jobs_task_name_check CHECK (
        dispatch_task_name IS NULL
        OR (
            pg_catalog.char_length(dispatch_task_name) BETWEEN 1 AND 512
            AND dispatch_task_name ~ '^[A-Za-z0-9][A-Za-z0-9._:/=-]*$'
        )
    );

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_job_dispatched(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_task_name TEXT
)
RETURNS TABLE(marked BOOLEAN, job_status TEXT, dispatch_state TEXT, task_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_dispatch_token IS NULL
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_task_name IS NULL
       OR pg_catalog.char_length(p_task_name) NOT BETWEEN 1 AND 512
       OR p_task_name !~ '^[A-Za-z0-9][A-Za-z0-9._:/=-]*$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_DISPATCH_INPUT',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.dispatch_state IN ('enqueued', 'delivered') THEN
        IF v_job.dispatch_generation = p_dispatch_generation
           AND v_job.dispatch_reservation_token = p_dispatch_token
           AND v_job.dispatch_task_name = p_task_name THEN
            RETURN QUERY SELECT
                TRUE,
                v_job.status::TEXT,
                v_job.dispatch_state::TEXT,
                v_job.dispatch_task_name::TEXT;
            RETURN;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'pending'
       OR v_job.dispatch_state <> 'reserved'
       OR v_job.dispatch_generation <> p_dispatch_generation
       OR v_job.dispatch_reservation_token <> p_dispatch_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET dispatch_state = 'enqueued',
        dispatched_at = v_now,
        dispatch_task_name = p_task_name,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'processing',
        background_processing = TRUE,
        progress_step = 'V2 analysis queued',
        current_step = 'v2_pipeline'
    WHERE analysis_request.id = p_request_id
      AND analysis_request.status IN ('pending', 'processing');

    RETURN QUERY SELECT
        TRUE,
        v_job.status::TEXT,
        v_job.dispatch_state::TEXT,
        v_job.dispatch_task_name::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_job_dispatched(
    UUID, TEXT, INTEGER, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_job_dispatched(
    UUID, TEXT, INTEGER, UUID, TEXT
) TO service_role;
