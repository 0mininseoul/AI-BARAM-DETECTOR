CREATE OR REPLACE FUNCTION public.set_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,
    p_user_id UUID,
    p_decision TEXT,
    p_excluded_instagram_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_excluded_instagram_id TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_decision IS NULL
       OR p_decision NOT IN ('exclude', 'skip') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    IF p_decision = 'exclude' THEN
        v_excluded_instagram_id := pg_catalog.lower(pg_catalog.btrim(p_excluded_instagram_id));
        IF v_excluded_instagram_id IS NULL
           OR v_excluded_instagram_id !~ '^[a-z0-9._]{1,30}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
        END IF;
    ELSIF p_excluded_instagram_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.exclusion_decision = p_decision
       AND v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id THEN
        RETURN FALSE;
    END IF;
    IF v_preflight.exclusion_decision <> 'pending' THEN
        RAISE EXCEPTION USING MESSAGE = 'PREFLIGHT_IMMUTABLE', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status = 'consumed' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_CONSUMED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status NOT IN ('pending', 'processing', 'ready') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF p_decision = 'exclude' AND v_excluded_instagram_id = v_preflight.target_instagram_id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET exclusion_decision = p_decision,
        excluded_instagram_id = v_excluded_instagram_id,
        exclusion_decided_at = v_now,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id
      AND preflight.exclusion_decision = 'pending';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PREFLIGHT_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.set_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
    TO service_role;
