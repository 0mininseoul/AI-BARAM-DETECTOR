-- Apify represents hidden engagement counts with -1. The application normalizes the numeric
-- value to zero, but must retain that it was hidden so downstream absence checks stay
-- conservative. Keep the original validator as the canonical shape validator and wrap it with
-- a narrowly-scoped extension for the two true-only visibility markers.

ALTER FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
    RENAME TO analysis_v2_valid_profile_snapshot_without_hidden_counts;

CREATE FUNCTION public.analysis_v2_valid_profile_snapshot(p_profile JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
            CASE
                WHEN pg_catalog.jsonb_typeof(p_profile->'latestPosts') = 'array'
                    THEN p_profile->'latestPosts'
                ELSE '[]'::JSONB
            END
        ) AS post(value)
        WHERE (
                post.value ? 'likesCountHidden'
                AND (
                    pg_catalog.jsonb_typeof(post.value->'likesCountHidden') <> 'boolean'
                    OR post.value->>'likesCountHidden' <> 'true'
                )
            )
           OR (
                post.value ? 'commentsCountHidden'
                AND (
                    pg_catalog.jsonb_typeof(post.value->'commentsCountHidden') <> 'boolean'
                    OR post.value->>'commentsCountHidden' <> 'true'
                )
            )
    )
    AND public.analysis_v2_valid_profile_snapshot_without_hidden_counts(
        CASE
            WHEN pg_catalog.jsonb_typeof(p_profile->'latestPosts') = 'array' THEN
                (p_profile - 'latestPosts')
                || pg_catalog.jsonb_build_object(
                    'latestPosts',
                    COALESCE((
                        SELECT pg_catalog.jsonb_agg(
                            post.value - 'likesCountHidden' - 'commentsCountHidden'
                            ORDER BY post.ordinality
                        )
                        FROM pg_catalog.jsonb_array_elements(p_profile->'latestPosts')
                            WITH ORDINALITY AS post(value, ordinality)
                    ), '[]'::JSONB)
                )
            ELSE p_profile
        END
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot_without_hidden_counts(JSONB)
    FROM PUBLIC, anon, authenticated;

-- A CHECK constraint binds a function by OID, so recreate it against the wrapper after the
-- rename. RPC validators resolve the public function name and therefore use the wrapper too.
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    DROP CONSTRAINT analysis_v2_profile_outcomes_result_check;

ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    ADD CONSTRAINT analysis_v2_profile_outcomes_result_check CHECK (
        (
            status = 'success'
            AND failure_category IS NULL
            AND http_status IS NULL
            AND profile_snapshot IS NOT NULL
            AND public.analysis_v2_valid_profile_snapshot(profile_snapshot)
            AND profile_snapshot->>'username' = username
        )
        OR (
            status = 'unavailable'
            AND failure_category IN ('not_found', 'empty_user')
            AND (http_status IS NULL OR http_status = 404)
            AND profile_snapshot IS NULL
        )
        OR (
            status = 'failed'
            AND failure_category IN (
                'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                'transport', 'http', 'unknown'
            )
            AND (http_status IS NULL OR http_status BETWEEN 400 AND 599)
            AND profile_snapshot IS NULL
        )
    );

COMMENT ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB) IS
    'Validates bounded V2 profile snapshots, including true-only hidden engagement markers.';
