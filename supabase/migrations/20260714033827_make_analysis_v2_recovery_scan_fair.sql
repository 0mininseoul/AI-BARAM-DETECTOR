-- Bound recovery by the age of the recoverable condition, not by dispatch state.
-- A state-first order lets a steady stream of fresh pending jobs permanently hide
-- stale deliveries and expired processing leases behind the scheduler's scan limit.
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
    WITH recoverable_jobs AS (
        SELECT
            job.request_id,
            job.job_key,
            job.status,
            job.dispatch_state,
            job.dispatch_generation,
            job.dispatch_reservation_token,
            job.dispatch_reserved_at,
            job.dispatched_at,
            job.dispatch_task_name,
            job.lease_expires_at,
            CASE
                WHEN job.status = 'processing' THEN job.lease_expires_at
                WHEN job.dispatch_state IN ('enqueued', 'delivered')
                    THEN job.updated_at + INTERVAL '2 minutes'
                WHEN job.dispatch_state = 'reserved'
                    THEN COALESCE(job.dispatch_reserved_at, job.updated_at, job.created_at)
                ELSE job.created_at
            END AS recoverable_at
        FROM public.analysis_pipeline_jobs AS job
        JOIN public.analysis_requests AS analysis_request
          ON analysis_request.id = job.request_id
        WHERE analysis_request.pipeline_version = 'v2'
          AND analysis_request.status IN ('pending', 'processing')
          AND (
                (
                    job.status = 'pending'
                    AND (
                        job.dispatch_state IN ('pending', 'reserved')
                        OR (
                            job.dispatch_state IN ('enqueued', 'delivered')
                            AND job.updated_at <= clock_timestamp() - INTERVAL '2 minutes'
                        )
                    )
                )
                OR (
                    job.status = 'processing'
                    AND job.lease_expires_at <= clock_timestamp()
                )
          )
    )
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
    FROM recoverable_jobs AS job
    ORDER BY
        job.recoverable_at,
        job.request_id,
        job.job_key
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.list_analysis_v2_dispatchable_jobs(INTEGER) IS
    'Lists recoverable V2 jobs oldest-recoverable-first so bounded scheduler scans cannot starve a dispatch state.';
