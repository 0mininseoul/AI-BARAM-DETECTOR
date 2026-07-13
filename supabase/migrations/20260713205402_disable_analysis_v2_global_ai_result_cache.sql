-- Derived gender, appearance, exposure, business, marriage, and partner inferences
-- are request-scoped personal data. Disable cross-request result reuse before launch.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_ai_result_identity(
    p_identity JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_typeof(p_identity) = 'object'
       AND p_identity ?& ARRAY[
            'stage', 'model_name', 'thinking_level', 'media_resolution',
            'prompt_version', 'schema_version', 'input_hash',
            'max_output_tokens', 'media_snapshot_hash', 'cache_scope'
       ]
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_identity) AS identity_key(value)
            WHERE identity_key.value <> ALL(ARRAY[
                'stage', 'model_name', 'thinking_level', 'media_resolution',
                'prompt_version', 'schema_version', 'input_hash',
                'max_output_tokens', 'media_snapshot_hash', 'cache_scope'
            ])
       )
       AND pg_catalog.jsonb_typeof(p_identity->'stage') = 'string'
       AND p_identity->>'stage' IN (
            'genderTriage', 'featureAnalysis', 'highRiskNarrative',
            'privateAccountName', 'partnerSafety'
       )
       AND pg_catalog.jsonb_typeof(p_identity->'model_name') = 'string'
       AND p_identity->>'model_name' ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
       AND (
            p_identity->'thinking_level' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_identity->'thinking_level') = 'string'
                AND p_identity->>'thinking_level' IN ('MINIMAL', 'LOW', 'MEDIUM', 'HIGH')
            )
       )
       AND (
            p_identity->'media_resolution' = 'null'::JSONB
            OR (
                pg_catalog.jsonb_typeof(p_identity->'media_resolution') = 'string'
                AND p_identity->>'media_resolution' IN ('LOW', 'MEDIUM', 'HIGH')
            )
       )
       AND pg_catalog.jsonb_typeof(p_identity->'prompt_version') = 'string'
       AND pg_catalog.char_length(p_identity->>'prompt_version') BETWEEN 1 AND 64
       AND p_identity->>'prompt_version' ~ '^[A-Za-z0-9._:-]+$'
       AND pg_catalog.jsonb_typeof(p_identity->'schema_version') = 'number'
       AND p_identity->>'schema_version' ~ '^[1-9][0-9]{0,3}$'
       AND (p_identity->>'schema_version')::INTEGER BETWEEN 1 AND 9999
       AND pg_catalog.jsonb_typeof(p_identity->'max_output_tokens') = 'number'
       AND p_identity->>'max_output_tokens' ~ '^[1-9][0-9]{0,4}$'
       AND (p_identity->>'max_output_tokens')::INTEGER BETWEEN 1 AND 65536
       AND pg_catalog.jsonb_typeof(p_identity->'input_hash') = 'string'
       AND p_identity->>'input_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_identity->'media_snapshot_hash') = 'string'
       AND p_identity->>'media_snapshot_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_identity->'cache_scope') = 'string'
       AND p_identity->>'cache_scope' = 'request';
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_ai_result_identity(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_ai_global_cache_hit(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.maintain_analysis_v2_ai_global_result_cache(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

DELETE FROM public.analysis_v2_ai_global_result_cache;

CREATE OR REPLACE FUNCTION public.analysis_v2_reject_global_ai_result_cache_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_V2_GLOBAL_AI_RESULT_CACHE_DISABLED',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_reject_global_ai_result_cache_write()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS analysis_v2_reject_global_ai_result_cache_write
    ON public.analysis_v2_ai_global_result_cache;
CREATE TRIGGER analysis_v2_reject_global_ai_result_cache_write
    BEFORE INSERT OR UPDATE ON public.analysis_v2_ai_global_result_cache
    FOR EACH ROW
    EXECUTE FUNCTION public.analysis_v2_reject_global_ai_result_cache_write();

COMMENT ON TABLE public.analysis_v2_ai_global_result_cache IS
    'Disabled compatibility shell. Cross-request storage of derived personal AI results is forbidden.';
