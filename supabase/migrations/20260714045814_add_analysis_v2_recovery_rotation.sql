-- Persist the next time a live job should participate in recovery. Cloud Tasks
-- entries that still exist are deferred without mutating dispatch age, allowing
-- later actionable jobs to enter the next bounded scheduler scan.
ALTER TABLE public.analysis_pipeline_jobs
    ADD COLUMN recovery_checked_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN recovery_not_before TIMESTAMP WITH TIME ZONE;

CREATE OR REPLACE FUNCTION public.analysis_v2_set_job_recovery_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.dispatch_state IS NOT DISTINCT FROM OLD.dispatch_state
       AND NEW.dispatch_generation IS NOT DISTINCT FROM OLD.dispatch_generation
       AND NEW.dispatch_reservation_token
            IS NOT DISTINCT FROM OLD.dispatch_reservation_token
       AND NEW.dispatch_reserved_at IS NOT DISTINCT FROM OLD.dispatch_reserved_at
       AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
       AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
        RETURN NEW;
    END IF;

    NEW.recovery_checked_at := NULL;
    NEW.recovery_not_before := CASE
        WHEN NEW.status = 'pending' AND NEW.dispatch_state = 'pending'
            THEN NEW.created_at
        WHEN NEW.status = 'pending' AND NEW.dispatch_state = 'reserved'
            THEN NEW.dispatch_reserved_at
        WHEN NEW.status = 'pending'
             AND NEW.dispatch_state IN ('enqueued', 'delivered')
            THEN NEW.updated_at + INTERVAL '2 minutes'
        WHEN NEW.status = 'processing'
            THEN NEW.lease_expires_at
        ELSE NULL
    END;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_set_job_recovery_schedule()
    FROM PUBLIC, anon, authenticated, service_role;

UPDATE public.analysis_pipeline_jobs AS job
SET recovery_checked_at = NULL,
    recovery_not_before = CASE
        WHEN job.status = 'pending' AND job.dispatch_state = 'pending'
            THEN job.created_at
        WHEN job.status = 'pending' AND job.dispatch_state = 'reserved'
            THEN job.dispatch_reserved_at
        WHEN job.status = 'pending'
             AND job.dispatch_state IN ('enqueued', 'delivered')
            THEN job.updated_at + INTERVAL '2 minutes'
        WHEN job.status = 'processing'
            THEN job.lease_expires_at
        ELSE NULL
    END;

ALTER TABLE public.analysis_pipeline_jobs
    ADD CONSTRAINT analysis_pipeline_jobs_recovery_schedule_check CHECK (
        (
            status IN ('pending', 'processing')
            AND recovery_not_before IS NOT NULL
        )
        OR (
            status IN ('completed', 'failed', 'cancelled')
            AND recovery_checked_at IS NULL
            AND recovery_not_before IS NULL
        )
    ),
    ADD CONSTRAINT analysis_pipeline_jobs_recovery_defer_check CHECK (
        recovery_checked_at IS NULL
        OR recovery_not_before > recovery_checked_at
    );

CREATE TRIGGER analysis_v2_job_recovery_schedule
BEFORE INSERT OR UPDATE ON public.analysis_pipeline_jobs
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_set_job_recovery_schedule();

CREATE INDEX idx_analysis_pipeline_jobs_recovery_ready
    ON public.analysis_pipeline_jobs(recovery_not_before, request_id, job_key)
    WHERE status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.defer_analysis_v2_job_recovery(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_expected_status TEXT,
    p_expected_lease_expires_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_deferred BOOLEAN;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_dispatch_token IS NULL
       OR p_expected_status IS NULL
       OR p_expected_status NOT IN ('pending', 'processing')
       OR (
            p_expected_status = 'pending'
            AND p_expected_lease_expires_at IS NOT NULL
       )
       OR (
            p_expected_status = 'processing'
            AND p_expected_lease_expires_at IS NULL
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_RECOVERY_DEFER_INPUT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET recovery_checked_at = v_now,
        recovery_not_before = v_now + INTERVAL '5 minutes'
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.status = p_expected_status
      AND job.dispatch_state IN ('enqueued', 'delivered')
      AND job.dispatch_generation = p_dispatch_generation
      AND job.dispatch_reservation_token = p_dispatch_token
      AND job.lease_expires_at IS NOT DISTINCT FROM p_expected_lease_expires_at
      AND job.recovery_not_before <= v_now
      AND (
            (
                job.status = 'pending'
                AND job.updated_at <= v_now - INTERVAL '2 minutes'
            )
            OR (
                job.status = 'processing'
                AND job.lease_expires_at <= v_now
            )
      )
      AND EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = job.request_id
              AND analysis_request.pipeline_version = 'v2'
              AND analysis_request.status IN ('pending', 'processing')
      )
    RETURNING TRUE INTO v_deferred;

    RETURN COALESCE(v_deferred, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.defer_analysis_v2_job_recovery(
    UUID, TEXT, INTEGER, UUID, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.defer_analysis_v2_job_recovery(
    UUID, TEXT, INTEGER, UUID, TEXT, TIMESTAMP WITH TIME ZONE
) TO service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_v2_dispatchable_jobs(
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(
    request_id UUID,
    job_key TEXT,
    job_status TEXT,
    dispatch_state TEXT,
    dispatch_generation INTEGER,
    reservation_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    task_name TEXT,
    lease_expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_SCAN_INPUT', ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT
        job.request_id,
        job.job_key::TEXT,
        job.status::TEXT,
        job.dispatch_state::TEXT,
        job.dispatch_generation,
        job.dispatch_reservation_token,
        job.dispatch_reserved_at,
        job.dispatched_at,
        job.dispatch_task_name::TEXT,
        job.lease_expires_at
    FROM public.analysis_pipeline_jobs AS job
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = job.request_id
    WHERE analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
      AND job.status IN ('pending', 'processing')
      AND job.recovery_not_before <= pg_catalog.clock_timestamp()
    ORDER BY job.recovery_not_before, job.request_id, job.job_key
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    TO service_role;

COMMENT ON COLUMN public.analysis_pipeline_jobs.recovery_checked_at IS
    'Last exact-fence Cloud Tasks existence check that deferred this job from recovery.';
COMMENT ON COLUMN public.analysis_pipeline_jobs.recovery_not_before IS
    'Indexed durable time when this live job may next enter a bounded recovery scan.';
COMMENT ON FUNCTION public.defer_analysis_v2_job_recovery(
    UUID, TEXT, INTEGER, UUID, TEXT, TIMESTAMP WITH TIME ZONE
) IS 'Defers one exact live generation after Cloud Tasks confirms its task still exists.';
COMMENT ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER) IS
    'Lists indexed recovery-ready V2 jobs; task-present checks rotate out for five minutes.';
