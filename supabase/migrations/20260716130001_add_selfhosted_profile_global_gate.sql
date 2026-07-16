CREATE TABLE public.selfhosted_profile_request_start_gate (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    next_start_at TIMESTAMP WITH TIME ZONE NOT NULL
);

INSERT INTO public.selfhosted_profile_request_start_gate (singleton, next_start_at)
VALUES (TRUE, pg_catalog.clock_timestamp());

ALTER TABLE public.selfhosted_profile_request_start_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.selfhosted_profile_request_start_gate FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.selfhosted_profile_request_start_gate
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_selfhosted_profile_request_start(
    p_min_interval_ms INTEGER,
    p_response_guard_ms INTEGER,
    p_max_wait_ms INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_next_start_at TIMESTAMP WITH TIME ZONE;
    v_now TIMESTAMP WITH TIME ZONE;
    v_reserved_at TIMESTAMP WITH TIME ZONE;
    v_advanced_next_start_at TIMESTAMP WITH TIME ZONE;
    v_wait_ms BIGINT;
BEGIN
    IF p_min_interval_ms IS NULL
       OR p_min_interval_ms NOT BETWEEN 250 AND 60000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_INVALID_INTERVAL',
            ERRCODE = 'P0001';
    END IF;
    IF p_response_guard_ms IS NULL
       OR p_response_guard_ms NOT BETWEEN 50 AND 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_INVALID_RESPONSE_GUARD',
            ERRCODE = 'P0001';
    END IF;
    IF p_max_wait_ms IS NULL
       OR p_max_wait_ms NOT BETWEEN 0 AND 300000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_INVALID_MAX_WAIT',
            ERRCODE = 'P0001';
    END IF;

    SELECT gate.next_start_at
    INTO v_next_start_at
    FROM public.selfhosted_profile_request_start_gate AS gate
    WHERE gate.singleton IS TRUE
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_CORRUPT_STATE',
            ERRCODE = 'P0001';
    END IF;
    IF v_next_start_at IS NULL OR NOT pg_catalog.isfinite(v_next_start_at) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_CORRUPT_STATE',
            ERRCODE = 'P0001';
    END IF;

    v_now := pg_catalog.clock_timestamp();
    v_reserved_at := GREATEST(v_now, v_next_start_at);
    v_wait_ms := pg_catalog.ceil(
        pg_catalog.date_part('epoch', v_reserved_at - v_now) * 1000.0
    )::BIGINT;

    IF NOT pg_catalog.isfinite(v_reserved_at)
       OR v_wait_ms < 0 OR v_wait_ms > 300000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_WAIT_OUT_OF_RANGE',
            ERRCODE = 'P0001';
    END IF;
    IF v_wait_ms > p_max_wait_ms THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_CALLER_WAIT_EXCEEDED',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.selfhosted_profile_request_start_gate AS gate
    SET next_start_at = v_reserved_at + pg_catalog.make_interval(
        secs => (p_min_interval_ms + p_response_guard_ms)::DOUBLE PRECISION / 1000.0
    )
    WHERE gate.singleton IS TRUE
    RETURNING gate.next_start_at INTO v_advanced_next_start_at;

    IF NOT FOUND
       OR NOT pg_catalog.isfinite(v_advanced_next_start_at)
       OR v_advanced_next_start_at <= v_reserved_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'SELFHOSTED_PROFILE_GLOBAL_GATE_CORRUPT_STATE',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'waitMs', v_wait_ms,
        'reservedAt', v_reserved_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_selfhosted_profile_request_start(INTEGER, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_selfhosted_profile_request_start(INTEGER, INTEGER, INTEGER)
    TO service_role;

COMMENT ON TABLE public.selfhosted_profile_request_start_gate IS
    'PII-free singleton coordinating aggregate unauthenticated public-profile request starts.';
COMMENT ON FUNCTION public.reserve_selfhosted_profile_request_start(INTEGER, INTEGER, INTEGER) IS
    'Atomically reserves one bounded aggregate request-start time without sleeping.';
