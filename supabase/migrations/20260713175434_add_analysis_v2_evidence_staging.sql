-- Phase F: durable relationship and raw target-interaction evidence staging.
-- All raw usernames and comment text remain RPC-only PII. Terminal cleanup is intentionally
-- deferred to the Phase G atomic finalizer so cost/provider/AI ledgers can never be co-deleted.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_relationship_rows(p_rows JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_rows IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_rows) = 'array'
       AND pg_catalog.jsonb_array_length(p_rows) <= 1200
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS relationship_row(value)
            WHERE pg_catalog.jsonb_typeof(relationship_row.value) <> 'object'
               OR NOT relationship_row.value ?& ARRAY[
                    'username', 'is_private', 'is_verified', 'full_name', 'profile_pic_url'
               ]
               OR relationship_row.value - ARRAY[
                    'username', 'is_private', 'is_verified', 'full_name', 'profile_pic_url'
               ] <> '{}'::JSONB
               OR pg_catalog.jsonb_typeof(relationship_row.value->'username') <> 'string'
               OR relationship_row.value->>'username' !~ '^[a-z0-9._]{1,30}$'
               OR pg_catalog.jsonb_typeof(relationship_row.value->'is_private') <> 'boolean'
               OR pg_catalog.jsonb_typeof(relationship_row.value->'is_verified') <> 'boolean'
               OR NOT (
                    relationship_row.value->'full_name' = 'null'::JSONB
                    OR (
                        pg_catalog.jsonb_typeof(relationship_row.value->'full_name') = 'string'
                        AND pg_catalog.char_length(relationship_row.value->>'full_name')
                            BETWEEN 1 AND 200
                        AND pg_catalog.octet_length(relationship_row.value->>'full_name') <= 800
                        AND relationship_row.value->>'full_name' !~ '[[:cntrl:]]'
                    )
               )
               OR NOT (
                    relationship_row.value->'profile_pic_url' = 'null'::JSONB
                    OR (
                        pg_catalog.jsonb_typeof(relationship_row.value->'profile_pic_url') = 'string'
                        AND pg_catalog.char_length(relationship_row.value->>'profile_pic_url')
                            BETWEEN 9 AND 8192
                        AND relationship_row.value->>'profile_pic_url' ~ '^https://'
                        AND relationship_row.value->>'profile_pic_url' !~ '[[:cntrl:]]'
                    )
               )
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS relationship_row(value)
            GROUP BY relationship_row.value->>'username'
            HAVING pg_catalog.count(*) > 1
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_relationship_rows(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_relationship_rows_hash(
    p_side TEXT,
    p_rows JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-relationship-result-v2'
                    || pg_catalog.chr(10)
                    || p_side
                    || pg_catalog.chr(10)
                    || COALESCE((
                        SELECT pg_catalog.string_agg(
                            relationship_row.ordinal::TEXT
                                || '|'
                                || pg_catalog.octet_length(
                                    relationship_row.value->>'username'
                                )::TEXT
                                || ':' || (relationship_row.value->>'username')
                                || '|'
                                || CASE
                                    WHEN (relationship_row.value->>'is_private')::BOOLEAN
                                    THEN '1' ELSE '0'
                                END
                                || '|'
                                || CASE
                                    WHEN (relationship_row.value->>'is_verified')::BOOLEAN
                                    THEN '1' ELSE '0'
                                END
                                || '|'
                                || pg_catalog.octet_length(
                                    COALESCE(relationship_row.value->>'full_name', '')
                                )::TEXT
                                || ':' || COALESCE(relationship_row.value->>'full_name', '')
                                || '|'
                                || pg_catalog.octet_length(
                                    COALESCE(relationship_row.value->>'profile_pic_url', '')
                                )::TEXT
                                || ':' || COALESCE(
                                    relationship_row.value->>'profile_pic_url', ''
                                ),
                            pg_catalog.chr(10)
                            ORDER BY relationship_row.ordinal
                        )
                        FROM pg_catalog.jsonb_array_elements(p_rows)
                            WITH ORDINALITY AS relationship_row(value, ordinal)
                    ), ''),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_relationship_rows_hash(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_iso_timestamp(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_timestamp TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_value IS NULL
       OR pg_catalog.char_length(p_value) > 64
       OR p_value !~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RETURN FALSE;
    END IF;
    v_timestamp := p_value::TIMESTAMP WITH TIME ZONE;
    RETURN v_timestamp IS NOT NULL;
EXCEPTION
    WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_iso_timestamp(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_target_evidence_rows(
    p_rows JSONB,
    p_target_username TEXT,
    p_excluded_username TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_rows IS NOT NULL
       AND p_target_username ~ '^[a-z0-9._]{1,30}$'
       AND (
            p_excluded_username IS NULL
            OR (
                p_excluded_username ~ '^[a-z0-9._]{1,30}$'
                AND p_excluded_username <> p_target_username
            )
       )
       AND pg_catalog.jsonb_typeof(p_rows) = 'array'
       AND pg_catalog.jsonb_array_length(p_rows) <= 690
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            WHERE pg_catalog.jsonb_typeof(evidence.value) <> 'object'
               OR NOT evidence.value ?& ARRAY[
                    'actor_username', 'post_id', 'signal', 'source_interaction_id',
                    'occurred_at', 'content'
               ]
               OR evidence.value - ARRAY[
                    'actor_username', 'post_id', 'signal', 'source_interaction_id',
                    'occurred_at', 'content'
               ] <> '{}'::JSONB
               OR pg_catalog.jsonb_typeof(evidence.value->'actor_username') <> 'string'
               OR evidence.value->>'actor_username' !~ '^[a-z0-9._]{1,30}$'
               OR evidence.value->>'actor_username' = p_target_username
               OR evidence.value->>'actor_username' = p_excluded_username
               OR pg_catalog.jsonb_typeof(evidence.value->'post_id') <> 'string'
               OR pg_catalog.char_length(evidence.value->>'post_id') NOT BETWEEN 1 AND 255
               OR evidence.value->>'post_id' ~ '[[:cntrl:]]'
               OR pg_catalog.jsonb_typeof(evidence.value->'source_interaction_id') <> 'string'
               OR pg_catalog.char_length(evidence.value->>'source_interaction_id')
                    NOT BETWEEN 1 AND 255
               OR evidence.value->>'source_interaction_id' ~ '[[:cntrl:]]'
               OR pg_catalog.jsonb_typeof(evidence.value->'signal') <> 'string'
               OR evidence.value->>'signal' NOT IN (
                    'target_post_like', 'target_post_comment'
               )
               OR NOT (
                    evidence.value->'occurred_at' = 'null'::JSONB
                    OR (
                        pg_catalog.jsonb_typeof(evidence.value->'occurred_at') = 'string'
                        AND public.analysis_v2_valid_iso_timestamp(
                            evidence.value->>'occurred_at'
                        )
                    )
               )
               OR NOT (
                    evidence.value->'content' = 'null'::JSONB
                    OR (
                        pg_catalog.jsonb_typeof(evidence.value->'content') = 'string'
                        AND pg_catalog.char_length(evidence.value->>'content') BETWEEN 1 AND 1000
                        AND pg_catalog.octet_length(evidence.value->>'content') <= 4000
                        AND evidence.value->>'content' !~ '[[:cntrl:]]'
                        AND evidence.value->>'content' !~ '[<>]'
                    )
               )
               OR (
                    evidence.value->>'signal' = 'target_post_like'
                    AND evidence.value->'content' <> 'null'::JSONB
               )
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            GROUP BY
                evidence.value->>'signal',
                evidence.value->>'source_interaction_id'
            HAVING pg_catalog.count(*) > 1
       )
       AND (
            SELECT pg_catalog.count(DISTINCT evidence.value->>'post_id')
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            WHERE evidence.value->>'signal' = 'target_post_like'
       ) <= 4
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            WHERE evidence.value->>'signal' = 'target_post_like'
            GROUP BY evidence.value->>'post_id'
            HAVING pg_catalog.count(*) > 150
       )
       AND (
            SELECT pg_catalog.count(DISTINCT evidence.value->>'post_id')
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            WHERE evidence.value->>'signal' = 'target_post_comment'
       ) <= 6
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            WHERE evidence.value->>'signal' = 'target_post_comment'
            GROUP BY evidence.value->>'post_id'
            HAVING pg_catalog.count(*) > 15
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_target_evidence_rows(
    JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_target_evidence_rows_hash(p_rows JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-target-evidence-rows-v2'
                    || pg_catalog.chr(10)
                    || COALESCE((
                        SELECT pg_catalog.string_agg(
                            evidence.ordinal::TEXT
                                || '|'
                                || (evidence.value->>'signal')
                                || '|'
                                || pg_catalog.octet_length(evidence.value->>'post_id')::TEXT
                                || ':' || (evidence.value->>'post_id')
                                || '|'
                                || pg_catalog.octet_length(
                                    evidence.value->>'source_interaction_id'
                                )::TEXT
                                || ':' || (evidence.value->>'source_interaction_id')
                                || '|'
                                || pg_catalog.octet_length(
                                    evidence.value->>'actor_username'
                                )::TEXT
                                || ':' || (evidence.value->>'actor_username')
                                || '|'
                                || pg_catalog.octet_length(
                                    COALESCE(evidence.value->>'occurred_at', '')
                                )::TEXT
                                || ':' || COALESCE(evidence.value->>'occurred_at', '')
                                || '|'
                                || pg_catalog.octet_length(
                                    COALESCE(evidence.value->>'content', '')
                                )::TEXT
                                || ':' || COALESCE(evidence.value->>'content', ''),
                            pg_catalog.chr(10)
                            ORDER BY evidence.ordinal
                        )
                        FROM pg_catalog.jsonb_array_elements(p_rows)
                            WITH ORDINALITY AS evidence(value, ordinal)
                    ), ''),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_target_evidence_rows_hash(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_target_evidence_source(
    p_signal TEXT,
    p_source JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_signal IN ('target_post_like', 'target_post_comment')
       AND p_source IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_source) = 'object'
       AND p_source ?& ARRAY[
            'status', 'input_hash', 'provider', 'provider_run_id',
            'provider_operation_key', 'provider_credential_slot', 'coverage'
       ]
       AND p_source - ARRAY[
            'status', 'input_hash', 'provider', 'provider_run_id',
            'provider_operation_key', 'provider_credential_slot', 'coverage'
       ] = '{}'::JSONB
       AND pg_catalog.jsonb_typeof(p_source->'status') = 'string'
       AND p_source->>'status' IN ('collected', 'not_applicable')
       AND pg_catalog.jsonb_typeof(p_source->'input_hash') = 'string'
       AND p_source->>'input_hash' ~ '^[0-9a-f]{64}$'
       AND pg_catalog.jsonb_typeof(p_source->'coverage') = 'array'
       AND pg_catalog.jsonb_array_length(p_source->'coverage') <= CASE p_signal
            WHEN 'target_post_like' THEN 4 ELSE 6
       END
       AND (
            (
                p_source->>'status' = 'not_applicable'
                AND p_source->'provider' = 'null'::JSONB
                AND p_source->'provider_run_id' = 'null'::JSONB
                AND p_source->'provider_operation_key' = 'null'::JSONB
                AND p_source->'provider_credential_slot' = 'null'::JSONB
                AND pg_catalog.jsonb_array_length(p_source->'coverage') = 0
            )
            OR (
                p_source->>'status' = 'collected'
                AND pg_catalog.jsonb_typeof(p_source->'provider') = 'string'
                AND p_source->>'provider' IN ('apify', 'coderx')
                AND pg_catalog.jsonb_typeof(p_source->'provider_run_id') = 'string'
                AND p_source->>'provider_run_id' ~ '^[A-Za-z0-9]{8,64}$'
                AND pg_catalog.jsonb_typeof(p_source->'provider_operation_key') = 'string'
                AND p_source->>'provider_operation_key' ~ CASE p_signal
                    WHEN 'target_post_like' THEN '^target-likers:[0-9a-f]{64}$'
                    ELSE '^target-comments:[0-9a-f]{64}$'
                END
                AND pg_catalog.jsonb_typeof(p_source->'provider_credential_slot') = 'string'
                AND p_source->>'provider_credential_slot' IN ('primary', 'secondary')
                AND pg_catalog.jsonb_array_length(p_source->'coverage') >= 1
            )
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage') AS coverage(value)
            WHERE pg_catalog.jsonb_typeof(coverage.value) <> 'object'
               OR NOT coverage.value ?& ARRAY[
                    'post_id', 'declared_count', 'returned_count', 'requested_limit'
               ]
               OR coverage.value - ARRAY[
                    'post_id', 'declared_count', 'returned_count', 'requested_limit'
               ] <> '{}'::JSONB
               OR pg_catalog.jsonb_typeof(coverage.value->'post_id') <> 'string'
               OR pg_catalog.char_length(coverage.value->>'post_id') NOT BETWEEN 1 AND 255
               OR coverage.value->>'post_id' ~ '[[:cntrl:]]'
               OR pg_catalog.jsonb_typeof(coverage.value->'declared_count') <> 'number'
               OR coverage.value->>'declared_count' !~ '^(0|[1-9][0-9]{0,7})$'
               OR (coverage.value->>'declared_count')::INTEGER > 10000000
               OR pg_catalog.jsonb_typeof(coverage.value->'returned_count') <> 'number'
               OR coverage.value->>'returned_count' !~ '^(0|[1-9][0-9]{0,2})$'
               OR (coverage.value->>'returned_count')::INTEGER > CASE p_signal
                    WHEN 'target_post_like' THEN 150 ELSE 15
               END
               OR pg_catalog.jsonb_typeof(coverage.value->'requested_limit') <> 'number'
               OR coverage.value->>'requested_limit' !~ '^(15|150)$'
               OR (coverage.value->>'requested_limit')::INTEGER <> CASE p_signal
                    WHEN 'target_post_like' THEN 150 ELSE 15
               END
               OR (coverage.value->>'returned_count')::INTEGER
                    > (coverage.value->>'requested_limit')::INTEGER
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage') AS coverage(value)
            GROUP BY coverage.value->>'post_id'
            HAVING pg_catalog.count(*) > 1
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_target_evidence_source(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_target_evidence_source_hash(
    p_signal TEXT,
    p_source JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-target-evidence-source-v1'
                    || pg_catalog.chr(10) || p_signal
                    || pg_catalog.chr(10) || (p_source->>'status')
                    || pg_catalog.chr(10) || (p_source->>'input_hash')
                    || pg_catalog.chr(10)
                    || pg_catalog.octet_length(COALESCE(p_source->>'provider', ''))::TEXT
                    || ':' || COALESCE(p_source->>'provider', '')
                    || pg_catalog.chr(10)
                    || pg_catalog.octet_length(
                        COALESCE(p_source->>'provider_run_id', '')
                    )::TEXT
                    || ':' || COALESCE(p_source->>'provider_run_id', '')
                    || pg_catalog.chr(10)
                    || pg_catalog.octet_length(
                        COALESCE(p_source->>'provider_operation_key', '')
                    )::TEXT
                    || ':' || COALESCE(p_source->>'provider_operation_key', '')
                    || pg_catalog.chr(10)
                    || pg_catalog.octet_length(
                        COALESCE(p_source->>'provider_credential_slot', '')
                    )::TEXT
                    || ':' || COALESCE(p_source->>'provider_credential_slot', '')
                    || CASE
                        WHEN pg_catalog.jsonb_array_length(p_source->'coverage') = 0 THEN ''
                        ELSE pg_catalog.chr(10) || (
                            SELECT pg_catalog.string_agg(
                                coverage.ordinal::TEXT
                                    || '|'
                                    || pg_catalog.octet_length(
                                        coverage.value->>'post_id'
                                    )::TEXT
                                    || ':' || (coverage.value->>'post_id')
                                    || '|' || (coverage.value->>'declared_count')
                                    || '|' || (coverage.value->>'returned_count')
                                    || '|' || (coverage.value->>'requested_limit'),
                                pg_catalog.chr(10)
                                ORDER BY coverage.ordinal
                            )
                            FROM pg_catalog.jsonb_array_elements(p_source->'coverage')
                                WITH ORDINALITY AS coverage(value, ordinal)
                        )
                    END,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_target_evidence_source_hash(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_target_evidence_result_hash(
    p_rows JSONB,
    p_liker_source JSONB,
    p_comment_source JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-target-evidence-result-v2'
                    || pg_catalog.chr(10)
                    || public.analysis_v2_target_evidence_rows_hash(p_rows)
                    || pg_catalog.chr(10)
                    || public.analysis_v2_target_evidence_source_hash(
                        'target_post_like', p_liker_source
                    )
                    || pg_catalog.chr(10)
                    || public.analysis_v2_target_evidence_source_hash(
                        'target_post_comment', p_comment_source
                    ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_target_evidence_result_hash(
    JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_relationship_sides (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    side VARCHAR(16) NOT NULL,
    job_claim_token UUID NOT NULL,
    provider VARCHAR(16) NOT NULL,
    provider_run_id VARCHAR(128) NOT NULL,
    provider_operation_key VARCHAR(128) NOT NULL,
    provider_credential_slot VARCHAR(16) NOT NULL,
    declared_count SMALLINT NOT NULL,
    collected_count SMALLINT NOT NULL,
    coverage_bps SMALLINT NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    result_hash VARCHAR(64) NOT NULL,
    revision SMALLINT NOT NULL DEFAULT 1,
    completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, side),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_relationship_sides_side_check CHECK (
        side IN ('followers', 'following')
    ),
    CONSTRAINT analysis_v2_relationship_sides_provider_check CHECK (
        provider IN ('apify', 'coderx')
    ),
    CONSTRAINT analysis_v2_relationship_sides_credential_check CHECK (
        provider_credential_slot IN ('primary', 'secondary')
    ),
    CONSTRAINT analysis_v2_relationship_sides_run_id_check CHECK (
        provider_run_id ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT analysis_v2_relationship_sides_operation_check CHECK (
        provider_operation_key ~ (
            '^relationship-' || side || ':[0-9a-f]{64}$'
        )
    ),
    CONSTRAINT analysis_v2_relationship_sides_count_check CHECK (
        declared_count BETWEEN 0 AND 1200
        AND collected_count BETWEEN 0 AND declared_count
        AND (
            (declared_count = 0 AND collected_count = 0 AND coverage_bps = 10000)
            OR (
                declared_count > 0
                AND collected_count * 100 >= declared_count * 99
                AND coverage_bps = (collected_count::INTEGER * 10000) / declared_count
            )
        )
    ),
    CONSTRAINT analysis_v2_relationship_sides_hash_check CHECK (
        input_hash ~ '^[0-9a-f]{64}$'
        AND result_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_relationship_sides_revision_check CHECK (revision = 1),
    CONSTRAINT analysis_v2_relationship_sides_timestamp_check CHECK (
        completed_at >= created_at AND updated_at >= created_at
    )
);

CREATE TABLE public.analysis_v2_relationship_rows (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    side VARCHAR(16) NOT NULL,
    ordinal SMALLINT NOT NULL,
    username VARCHAR(30) NOT NULL,
    is_private BOOLEAN NOT NULL,
    is_verified BOOLEAN NOT NULL,
    full_name VARCHAR(200),
    profile_pic_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, side, username),
    UNIQUE (request_id, job_key, side, ordinal),
    FOREIGN KEY (request_id, job_key, side)
        REFERENCES public.analysis_v2_relationship_sides(request_id, job_key, side)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_relationship_rows_side_check CHECK (
        side IN ('followers', 'following')
    ),
    CONSTRAINT analysis_v2_relationship_rows_ordinal_check CHECK (
        ordinal BETWEEN 1 AND 1200
    ),
    CONSTRAINT analysis_v2_relationship_rows_username_check CHECK (
        username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_relationship_rows_profile_check CHECK (
        (
            full_name IS NULL
            OR (
                pg_catalog.char_length(full_name) BETWEEN 1 AND 200
                AND pg_catalog.octet_length(full_name) <= 800
                AND full_name !~ '[[:cntrl:]]'
            )
        )
        AND (
            profile_pic_url IS NULL
            OR (
                pg_catalog.char_length(profile_pic_url) BETWEEN 9 AND 8192
                AND profile_pic_url ~ '^https://'
                AND profile_pic_url !~ '[[:cntrl:]]'
            )
        )
    )
);

CREATE TABLE public.analysis_v2_relationship_manifests (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    job_claim_token UUID NOT NULL,
    excluded_username VARCHAR(30),
    exclusion_decision_hash VARCHAR(64) NOT NULL,
    detailed_mutual_limit SMALLINT NOT NULL,
    followers_result_hash VARCHAR(64) NOT NULL,
    following_result_hash VARCHAR(64) NOT NULL,
    result_hash VARCHAR(64) NOT NULL,
    mutual_count SMALLINT NOT NULL,
    public_count SMALLINT NOT NULL,
    private_count SMALLINT NOT NULL,
    detailed_public_count SMALLINT NOT NULL,
    revision SMALLINT NOT NULL DEFAULT 1,
    frozen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_relationship_manifests_exclusion_check CHECK (
        excluded_username IS NULL OR excluded_username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_relationship_manifests_limit_check CHECK (
        detailed_mutual_limit IN (300, 600, 900)
    ),
    CONSTRAINT analysis_v2_relationship_manifests_hash_check CHECK (
        exclusion_decision_hash ~ '^[0-9a-f]{64}$'
        AND followers_result_hash ~ '^[0-9a-f]{64}$'
        AND following_result_hash ~ '^[0-9a-f]{64}$'
        AND result_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_relationship_manifests_count_check CHECK (
        mutual_count BETWEEN 0 AND 1200
        AND public_count BETWEEN 0 AND mutual_count
        AND private_count BETWEEN 0 AND mutual_count
        AND public_count + private_count = mutual_count
        AND detailed_public_count BETWEEN 0 AND public_count
        AND detailed_public_count <= detailed_mutual_limit
    ),
    CONSTRAINT analysis_v2_relationship_manifests_revision_check CHECK (revision = 1),
    CONSTRAINT analysis_v2_relationship_manifests_timestamp_check CHECK (
        frozen_at >= created_at AND updated_at >= created_at
    )
);

CREATE TABLE public.analysis_v2_mutual_rows (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    mutual_ordinal SMALLINT NOT NULL,
    following_ordinal SMALLINT NOT NULL,
    username VARCHAR(30) NOT NULL,
    is_private BOOLEAN NOT NULL,
    is_verified BOOLEAN NOT NULL,
    full_name VARCHAR(200),
    profile_pic_url TEXT,
    detailed_ordinal SMALLINT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, username),
    UNIQUE (request_id, job_key, mutual_ordinal),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_v2_relationship_manifests(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_mutual_rows_ordinal_check CHECK (
        mutual_ordinal BETWEEN 1 AND 1200
        AND following_ordinal BETWEEN 1 AND 1200
        AND (detailed_ordinal IS NULL OR detailed_ordinal BETWEEN 1 AND 900)
    ),
    CONSTRAINT analysis_v2_mutual_rows_username_check CHECK (
        username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_mutual_rows_profile_check CHECK (
        (
            full_name IS NULL
            OR (
                pg_catalog.char_length(full_name) BETWEEN 1 AND 200
                AND pg_catalog.octet_length(full_name) <= 800
                AND full_name !~ '[[:cntrl:]]'
            )
        )
        AND (
            profile_pic_url IS NULL
            OR (
                pg_catalog.char_length(profile_pic_url) BETWEEN 9 AND 8192
                AND profile_pic_url ~ '^https://'
                AND profile_pic_url !~ '[[:cntrl:]]'
            )
        )
    ),
    CONSTRAINT analysis_v2_mutual_rows_detail_check CHECK (
        (is_private AND detailed_ordinal IS NULL)
        OR NOT is_private
    )
);

CREATE UNIQUE INDEX idx_analysis_v2_mutual_rows_detailed
    ON public.analysis_v2_mutual_rows(request_id, job_key, detailed_ordinal)
    WHERE detailed_ordinal IS NOT NULL;
CREATE INDEX idx_analysis_v2_mutual_rows_private
    ON public.analysis_v2_mutual_rows(request_id, job_key, mutual_ordinal)
    WHERE is_private;

CREATE TABLE public.analysis_v2_target_evidence_manifests (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    job_claim_token UUID NOT NULL,
    target_username VARCHAR(30) NOT NULL,
    excluded_username VARCHAR(30),
    input_hash VARCHAR(64) NOT NULL,
    liker_source JSONB NOT NULL,
    comment_source JSONB NOT NULL,
    liker_source_hash VARCHAR(64) NOT NULL,
    comment_source_hash VARCHAR(64) NOT NULL,
    result_hash VARCHAR(64) NOT NULL,
    interactor_count SMALLINT NOT NULL,
    liker_count SMALLINT NOT NULL,
    comment_count SMALLINT NOT NULL,
    revision SMALLINT NOT NULL DEFAULT 1,
    frozen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_target_evidence_manifest_username_check CHECK (
        target_username ~ '^[a-z0-9._]{1,30}$'
        AND (
            excluded_username IS NULL
            OR (
                excluded_username ~ '^[a-z0-9._]{1,30}$'
                AND excluded_username <> target_username
            )
        )
    ),
    CONSTRAINT analysis_v2_target_evidence_manifest_hash_check CHECK (
        input_hash ~ '^[0-9a-f]{64}$'
        AND liker_source_hash ~ '^[0-9a-f]{64}$'
        AND comment_source_hash ~ '^[0-9a-f]{64}$'
        AND result_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_target_evidence_manifest_source_check CHECK (
        public.analysis_v2_valid_target_evidence_source(
            'target_post_like', liker_source
        )
        AND public.analysis_v2_valid_target_evidence_source(
            'target_post_comment', comment_source
        )
    ),
    CONSTRAINT analysis_v2_target_evidence_manifest_count_check CHECK (
        interactor_count BETWEEN 0 AND 690
        AND liker_count BETWEEN 0 AND 600
        AND comment_count BETWEEN 0 AND 90
        AND liker_count + comment_count = interactor_count
    ),
    CONSTRAINT analysis_v2_target_evidence_manifest_revision_check CHECK (revision = 1),
    CONSTRAINT analysis_v2_target_evidence_manifest_timestamp_check CHECK (
        frozen_at >= created_at AND updated_at >= created_at
    )
);

CREATE TABLE public.analysis_target_interactors (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    ordinal SMALLINT NOT NULL,
    actor_username VARCHAR(30) NOT NULL,
    post_id VARCHAR(255) NOT NULL,
    signal VARCHAR(32) NOT NULL,
    source_interaction_id VARCHAR(255) NOT NULL,
    occurred_at VARCHAR(64),
    comment_text VARCHAR(1000),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, signal, source_interaction_id),
    UNIQUE (request_id, job_key, ordinal),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_v2_target_evidence_manifests(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_target_interactors_ordinal_check CHECK (
        ordinal BETWEEN 1 AND 690
    ),
    CONSTRAINT analysis_target_interactors_username_check CHECK (
        actor_username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_target_interactors_id_check CHECK (
        pg_catalog.char_length(post_id) BETWEEN 1 AND 255
        AND post_id !~ '[[:cntrl:]]'
        AND pg_catalog.char_length(source_interaction_id) BETWEEN 1 AND 255
        AND source_interaction_id !~ '[[:cntrl:]]'
    ),
    CONSTRAINT analysis_target_interactors_signal_check CHECK (
        signal IN ('target_post_like', 'target_post_comment')
    ),
    CONSTRAINT analysis_target_interactors_timestamp_check CHECK (
        occurred_at IS NULL OR public.analysis_v2_valid_iso_timestamp(occurred_at)
    ),
    CONSTRAINT analysis_target_interactors_content_check CHECK (
        (signal = 'target_post_like' AND comment_text IS NULL)
        OR (
            signal = 'target_post_comment'
            AND (
                comment_text IS NULL
                OR (
                    pg_catalog.char_length(comment_text) BETWEEN 1 AND 1000
                    AND pg_catalog.octet_length(comment_text) <= 4000
                    AND comment_text !~ '[[:cntrl:]]'
                    AND comment_text !~ '[<>]'
                )
            )
        )
    )
);

CREATE INDEX idx_analysis_target_interactors_actor
    ON public.analysis_target_interactors(request_id, actor_username, signal);
CREATE INDEX idx_analysis_target_interactors_post
    ON public.analysis_target_interactors(request_id, job_key, signal, post_id);

ALTER TABLE public.analysis_v2_relationship_sides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_relationship_sides FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_relationship_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_relationship_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_relationship_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_relationship_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_mutual_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_mutual_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_target_evidence_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_target_evidence_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_target_interactors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_target_interactors FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_v2_relationship_sides
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_relationship_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_relationship_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_mutual_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_target_evidence_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_target_interactors
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_relationship_rows IS
    'RPC-only ordered relationship PII. Following ordinals preserve provider newest-first order.';
COMMENT ON TABLE public.analysis_v2_mutual_rows IS
    'Full post-exclusion mutual intersection up to 1200. detailed_ordinal limits only public feed screening.';
COMMENT ON TABLE public.analysis_target_interactors IS
    'RPC-only raw target liker/comment PII before verified-female joining; target and girlfriend are excluded at insert.';
COMMENT ON TABLE public.analysis_v2_target_evidence_manifests IS
    'Phase G must purge this header and analysis_target_interactors in its atomic terminal RPC; PII-free provider and AI ledgers are retained.';
COMMENT ON TABLE public.analysis_v2_relationship_manifests IS
    'Phase G must purge this header and all relationship/mutual PII rows in its atomic terminal RPC; no purge RPC is defined in Phase F.';

CREATE OR REPLACE FUNCTION public.analysis_v2_relationship_side_json(
    p_side public.analysis_v2_relationship_sides
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'side', p_side.side,
        'revision', p_side.revision,
        'declaredCount', p_side.declared_count,
        'collectedCount', p_side.collected_count,
        'coverageBps', p_side.coverage_bps,
        'inputHash', p_side.input_hash,
        'resultHash', p_side.result_hash
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_relationship_side_json(
    public.analysis_v2_relationship_sides
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_relationship_manifest_json(
    p_manifest public.analysis_v2_relationship_manifests
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'revision', p_manifest.revision,
        'resultHash', p_manifest.result_hash,
        'exclusionDecisionHash', p_manifest.exclusion_decision_hash,
        'followersResultHash', p_manifest.followers_result_hash,
        'followingResultHash', p_manifest.following_result_hash,
        'mutualCount', p_manifest.mutual_count,
        'publicCount', p_manifest.public_count,
        'privateCount', p_manifest.private_count,
        'detailedPublicCount', p_manifest.detailed_public_count,
        'unscreenedPublicCount',
            p_manifest.public_count - p_manifest.detailed_public_count
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_relationship_manifest_json(
    public.analysis_v2_relationship_manifests
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_target_evidence_manifest_json(
    p_manifest public.analysis_v2_target_evidence_manifests
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'revision', p_manifest.revision,
        'resultHash', p_manifest.result_hash,
        'inputHash', p_manifest.input_hash,
        'interactorCount', p_manifest.interactor_count,
        'likerCount', p_manifest.liker_count,
        'commentCount', p_manifest.comment_count
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_target_evidence_manifest_json(
    public.analysis_v2_target_evidence_manifests
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_target_evidence_source_json(
    p_source JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'status', p_source->>'status',
        'inputHash', p_source->>'input_hash',
        'provider', p_source->'provider',
        'providerRunId', p_source->'provider_run_id',
        'providerOperationKey', p_source->'provider_operation_key',
        'providerCredentialSlot', p_source->'provider_credential_slot',
        'coverage', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'postId', coverage.value->>'post_id',
                    'declaredCount', (coverage.value->>'declared_count')::INTEGER,
                    'returnedCount', (coverage.value->>'returned_count')::INTEGER,
                    'requestedLimit', (coverage.value->>'requested_limit')::INTEGER
                ) ORDER BY coverage.ordinal
            )
            FROM pg_catalog.jsonb_array_elements(p_source->'coverage')
                WITH ORDINALITY AS coverage(value, ordinal)
        ), '[]'::JSONB)
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_target_evidence_source_json(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_relationship_side(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_side TEXT,
    p_declared_count INTEGER,
    p_input_hash TEXT,
    p_result_hash TEXT,
    p_provider TEXT,
    p_provider_run_id TEXT,
    p_provider_operation_key TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_side public.analysis_v2_relationship_sides%ROWTYPE;
    v_provider_run public.analysis_v2_provider_runs%ROWTYPE;
    v_collected_count INTEGER;
    v_coverage_bps INTEGER;
    v_computed_hash TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_key <> 'track:relationships:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
       OR p_side IS NULL
       OR p_side NOT IN ('followers', 'following')
       OR p_declared_count IS NULL
       OR p_declared_count NOT BETWEEN 0 AND 1200
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_result_hash IS NULL
       OR p_result_hash !~ '^[0-9a-f]{64}$'
       OR p_provider IS NULL
       OR p_provider NOT IN ('apify', 'coderx')
       OR p_provider_run_id IS NULL
       OR p_provider_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_provider_operation_key IS NULL
       OR p_provider_operation_key !~
            ('^relationship-' || p_side || ':[0-9a-f]{64}$')
       OR NOT public.analysis_v2_valid_relationship_rows(p_rows) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_collected_count := pg_catalog.jsonb_array_length(p_rows);
    IF v_collected_count > p_declared_count
       OR v_collected_count * 100 < p_declared_count * 99 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;
    v_coverage_bps := CASE
        WHEN p_declared_count = 0 THEN 10000
        ELSE (v_collected_count * 10000) / p_declared_count
    END;
    v_computed_hash := public.analysis_v2_relationship_rows_hash(p_side, p_rows);
    IF v_computed_hash IS DISTINCT FROM p_result_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.status <> 'consumed'
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR p_declared_count IS DISTINCT FROM (CASE p_side
            WHEN 'followers' THEN v_preflight.target_followers_count
            ELSE v_preflight.target_following_count
       END) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_INCOMPLETE',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR p_declared_count > (
            v_request.analysis_scope_snapshot->'relationshipCapacity'->>p_side
       )::INTEGER THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.job_key <> 'track:relationships:collect'
       OR v_job.track <> 'relationships'
       OR v_job.kind <> 'collection'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_provider_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_provider_operation_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_provider_run.logical_provider IS DISTINCT FROM p_provider
       OR v_provider_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_provider_run.run_id IS DISTINCT FROM p_provider_run_id
       OR v_provider_run.status <> 'succeeded' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT relationship_side.*
    INTO v_side
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = p_side
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF FOUND THEN
        IF v_side.provider IS DISTINCT FROM p_provider
           OR v_side.provider_run_id IS DISTINCT FROM p_provider_run_id
           OR v_side.provider_operation_key IS DISTINCT FROM p_provider_operation_key
           OR v_side.provider_credential_slot IS DISTINCT FROM v_provider_run.credential_slot
           OR v_side.declared_count IS DISTINCT FROM p_declared_count
           OR v_side.collected_count IS DISTINCT FROM v_collected_count
           OR v_side.coverage_bps IS DISTINCT FROM v_coverage_bps
           OR v_side.input_hash IS DISTINCT FROM p_input_hash
           OR v_side.result_hash IS DISTINCT FROM p_result_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_SIDE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_relationship_sides AS relationship_side
        SET job_claim_token = p_claim_token,
            updated_at = v_now
        WHERE relationship_side.request_id = p_request_id
          AND relationship_side.job_key = p_job_key
          AND relationship_side.side = p_side
        RETURNING relationship_side.* INTO v_side;
        RETURN public.analysis_v2_relationship_side_json(v_side);
    END IF;

    INSERT INTO public.analysis_v2_relationship_sides (
        request_id,
        job_key,
        side,
        job_claim_token,
        provider,
        provider_run_id,
        provider_operation_key,
        provider_credential_slot,
        declared_count,
        collected_count,
        coverage_bps,
        input_hash,
        result_hash,
        completed_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_side,
        p_claim_token,
        p_provider,
        p_provider_run_id,
        p_provider_operation_key,
        v_provider_run.credential_slot,
        p_declared_count,
        v_collected_count,
        v_coverage_bps,
        p_input_hash,
        p_result_hash,
        v_now,
        v_now,
        v_now
    )
    RETURNING * INTO v_side;

    INSERT INTO public.analysis_v2_relationship_rows (
        request_id,
        job_key,
        side,
        ordinal,
        username,
        is_private,
        is_verified,
        full_name,
        profile_pic_url
    )
    SELECT
        p_request_id,
        p_job_key,
        p_side,
        relationship_row.ordinal::SMALLINT,
        relationship_row.value->>'username',
        (relationship_row.value->>'is_private')::BOOLEAN,
        (relationship_row.value->>'is_verified')::BOOLEAN,
        NULLIF(relationship_row.value->>'full_name', ''),
        NULLIF(relationship_row.value->>'profile_pic_url', '')
    FROM pg_catalog.jsonb_array_elements(p_rows)
        WITH ORDINALITY AS relationship_row(value, ordinal)
    ORDER BY relationship_row.ordinal;

    RETURN public.analysis_v2_relationship_side_json(v_side);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_relationship_side(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_relationship_side(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_relationship_freeze_hash(
    p_followers_hash TEXT,
    p_following_hash TEXT,
    p_exclusion_hash TEXT,
    p_detailed_limit INTEGER,
    p_mutual_rows JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-relationship-freeze-v2'
                    || pg_catalog.chr(10) || p_followers_hash
                    || pg_catalog.chr(10) || p_following_hash
                    || pg_catalog.chr(10) || p_exclusion_hash
                    || pg_catalog.chr(10) || p_detailed_limit::TEXT
                    || pg_catalog.chr(10)
                    || COALESCE((
                        SELECT pg_catalog.string_agg(
                            mutual.value->>'mutual_ordinal'
                                || '|'
                                || (mutual.value->>'following_ordinal')
                                || '|'
                                || pg_catalog.octet_length(
                                    mutual.value->>'username'
                                )::TEXT
                                || ':' || (mutual.value->>'username')
                                || '|'
                                || CASE
                                    WHEN (mutual.value->>'is_private')::BOOLEAN
                                    THEN '1' ELSE '0'
                                END
                                || '|'
                                || CASE
                                    WHEN (mutual.value->>'is_verified')::BOOLEAN
                                    THEN '1' ELSE '0'
                                END
                                || '|'
                                || pg_catalog.octet_length(
                                    COALESCE(mutual.value->>'full_name', '')
                                )::TEXT
                                || ':' || COALESCE(mutual.value->>'full_name', '')
                                || '|'
                                || pg_catalog.octet_length(
                                    COALESCE(mutual.value->>'profile_pic_url', '')
                                )::TEXT
                                || ':' || COALESCE(mutual.value->>'profile_pic_url', '')
                                || '|'
                                || COALESCE(mutual.value->>'detailed_ordinal', ''),
                            pg_catalog.chr(10)
                            ORDER BY (mutual.value->>'mutual_ordinal')::INTEGER
                        )
                        FROM pg_catalog.jsonb_array_elements(p_mutual_rows) AS mutual(value)
                    ), ''),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_relationship_freeze_hash(
    TEXT, TEXT, TEXT, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.freeze_analysis_v2_relationships(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_detailed_mutual_limit INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_followers public.analysis_v2_relationship_sides%ROWTYPE;
    v_following public.analysis_v2_relationship_sides%ROWTYPE;
    v_manifest public.analysis_v2_relationship_manifests%ROWTYPE;
    v_excluded_username TEXT;
    v_exclusion_hash TEXT;
    v_mutual_rows JSONB;
    v_mutual_count INTEGER;
    v_public_count INTEGER;
    v_private_count INTEGER;
    v_detailed_count INTEGER;
    v_result_hash TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_key <> 'track:relationships:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
       OR p_detailed_mutual_limit IS NULL
       OR p_detailed_mutual_limit NOT IN (300, 600, 900) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR (v_request.analysis_scope_snapshot->>'detailedMutualLimit')::INTEGER
            IS DISTINCT FROM p_detailed_mutual_limit THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.job_key <> 'track:relationships:collect'
       OR v_job.track <> 'relationships'
       OR v_job.kind <> 'collection'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT relationship_side.*
    INTO v_followers
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = 'followers'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT relationship_side.*
    INTO v_following
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = 'following'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_excluded_username := v_request.excluded_instagram_id;
    v_exclusion_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-girlfriend-exclusion-v1'
                    || pg_catalog.chr(10)
                    || CASE
                        WHEN v_excluded_username IS NULL THEN 'skip'
                        ELSE 'exclude:' || v_excluded_username
                    END,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    SELECT relationship_manifest.*
    INTO v_manifest
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF FOUND THEN
        IF v_manifest.excluded_username IS DISTINCT FROM v_excluded_username
           OR v_manifest.exclusion_decision_hash IS DISTINCT FROM v_exclusion_hash
           OR v_manifest.detailed_mutual_limit IS DISTINCT FROM p_detailed_mutual_limit
           OR v_manifest.followers_result_hash IS DISTINCT FROM v_followers.result_hash
           OR v_manifest.following_result_hash IS DISTINCT FROM v_following.result_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RELATIONSHIP_FREEZE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_relationship_manifests AS relationship_manifest
        SET job_claim_token = p_claim_token,
            updated_at = v_now
        WHERE relationship_manifest.request_id = p_request_id
          AND relationship_manifest.job_key = p_job_key
        RETURNING relationship_manifest.* INTO v_manifest;
        RETURN public.analysis_v2_relationship_manifest_json(v_manifest);
    END IF;

    WITH intersected AS (
        SELECT
            following_row.ordinal AS following_ordinal,
            following_row.username,
            following_row.is_private,
            following_row.is_verified,
            COALESCE(following_row.full_name, follower_row.full_name) AS full_name,
            COALESCE(
                following_row.profile_pic_url,
                follower_row.profile_pic_url
            ) AS profile_pic_url
        FROM public.analysis_v2_relationship_rows AS following_row
        INNER JOIN public.analysis_v2_relationship_rows AS follower_row
            ON follower_row.request_id = following_row.request_id
           AND follower_row.job_key = following_row.job_key
           AND follower_row.side = 'followers'
           AND follower_row.username = following_row.username
        WHERE following_row.request_id = p_request_id
          AND following_row.job_key = p_job_key
          AND following_row.side = 'following'
          AND following_row.username IS DISTINCT FROM v_excluded_username
    ), numbered AS (
        SELECT
            pg_catalog.row_number() OVER (
                ORDER BY intersected.following_ordinal
            )::INTEGER AS mutual_ordinal,
            intersected.*,
            pg_catalog.count(*) FILTER (WHERE NOT intersected.is_private) OVER (
                ORDER BY intersected.following_ordinal
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::INTEGER AS public_ordinal
        FROM intersected
    )
    SELECT
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'mutual_ordinal', numbered.mutual_ordinal,
                'following_ordinal', numbered.following_ordinal,
                'username', numbered.username,
                'is_private', numbered.is_private,
                'is_verified', numbered.is_verified,
                'full_name', numbered.full_name,
                'profile_pic_url', numbered.profile_pic_url,
                'detailed_ordinal', CASE
                    WHEN NOT numbered.is_private
                     AND numbered.public_ordinal <= p_detailed_mutual_limit
                    THEN numbered.public_ordinal
                    ELSE NULL
                END
            )
            ORDER BY numbered.mutual_ordinal
        ), '[]'::JSONB),
        pg_catalog.count(*)::INTEGER,
        pg_catalog.count(*) FILTER (WHERE NOT numbered.is_private)::INTEGER,
        pg_catalog.count(*) FILTER (WHERE numbered.is_private)::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE NOT numbered.is_private
              AND numbered.public_ordinal <= p_detailed_mutual_limit
        )::INTEGER
    INTO
        v_mutual_rows,
        v_mutual_count,
        v_public_count,
        v_private_count,
        v_detailed_count
    FROM numbered;

    IF v_mutual_count > 1200 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_result_hash := public.analysis_v2_relationship_freeze_hash(
        v_followers.result_hash,
        v_following.result_hash,
        v_exclusion_hash,
        p_detailed_mutual_limit,
        v_mutual_rows
    );

    INSERT INTO public.analysis_v2_relationship_manifests (
        request_id,
        job_key,
        job_claim_token,
        excluded_username,
        exclusion_decision_hash,
        detailed_mutual_limit,
        followers_result_hash,
        following_result_hash,
        result_hash,
        mutual_count,
        public_count,
        private_count,
        detailed_public_count,
        frozen_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_claim_token,
        v_excluded_username,
        v_exclusion_hash,
        p_detailed_mutual_limit,
        v_followers.result_hash,
        v_following.result_hash,
        v_result_hash,
        v_mutual_count,
        v_public_count,
        v_private_count,
        v_detailed_count,
        v_now,
        v_now,
        v_now
    )
    RETURNING * INTO v_manifest;

    INSERT INTO public.analysis_v2_mutual_rows (
        request_id,
        job_key,
        mutual_ordinal,
        following_ordinal,
        username,
        is_private,
        is_verified,
        full_name,
        profile_pic_url,
        detailed_ordinal
    )
    SELECT
        p_request_id,
        p_job_key,
        (mutual.value->>'mutual_ordinal')::SMALLINT,
        (mutual.value->>'following_ordinal')::SMALLINT,
        mutual.value->>'username',
        (mutual.value->>'is_private')::BOOLEAN,
        (mutual.value->>'is_verified')::BOOLEAN,
        NULLIF(mutual.value->>'full_name', ''),
        NULLIF(mutual.value->>'profile_pic_url', ''),
        CASE
            WHEN mutual.value->'detailed_ordinal' = 'null'::JSONB THEN NULL
            ELSE (mutual.value->>'detailed_ordinal')::SMALLINT
        END
    FROM pg_catalog.jsonb_array_elements(v_mutual_rows) AS mutual(value);

    RETURN public.analysis_v2_relationship_manifest_json(v_manifest);
END;
$$;

REVOKE ALL ON FUNCTION public.freeze_analysis_v2_relationships(
    UUID, TEXT, UUID, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.freeze_analysis_v2_relationships(
    UUID, TEXT, UUID, TEXT, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_relationship_staging(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_relationship_manifests%ROWTYPE;
    v_followers public.analysis_v2_relationship_sides%ROWTYPE;
    v_following public.analysis_v2_relationship_sides%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = p_request_id
              AND analysis_request.pipeline_version = 'v2'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT relationship_manifest.*
    INTO v_manifest
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = p_job_key;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT relationship_side.*
    INTO STRICT v_followers
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = 'followers';
    SELECT relationship_side.*
    INTO STRICT v_following
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = 'following';

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'excludedUsername', v_manifest.excluded_username,
        'detailedMutualLimit', v_manifest.detailed_mutual_limit,
        'manifest', public.analysis_v2_relationship_manifest_json(v_manifest),
        'followers', public.analysis_v2_relationship_side_json(v_followers)
            || pg_catalog.jsonb_build_object(
                'provider', v_followers.provider,
                'providerRunId', v_followers.provider_run_id,
                'providerOperationKey', v_followers.provider_operation_key,
                'providerCredentialSlot', v_followers.provider_credential_slot,
                'rows', COALESCE((
                    SELECT pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'username', relationship_row.username,
                            'isPrivate', relationship_row.is_private,
                            'isVerified', relationship_row.is_verified,
                            'fullName', relationship_row.full_name,
                            'profilePicUrl', relationship_row.profile_pic_url
                        ) ORDER BY relationship_row.ordinal
                    )
                    FROM public.analysis_v2_relationship_rows AS relationship_row
                    WHERE relationship_row.request_id = p_request_id
                      AND relationship_row.job_key = p_job_key
                      AND relationship_row.side = 'followers'
                ), '[]'::JSONB)
            ),
        'following', public.analysis_v2_relationship_side_json(v_following)
            || pg_catalog.jsonb_build_object(
                'provider', v_following.provider,
                'providerRunId', v_following.provider_run_id,
                'providerOperationKey', v_following.provider_operation_key,
                'providerCredentialSlot', v_following.provider_credential_slot,
                'rows', COALESCE((
                    SELECT pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'username', relationship_row.username,
                            'isPrivate', relationship_row.is_private,
                            'isVerified', relationship_row.is_verified,
                            'fullName', relationship_row.full_name,
                            'profilePicUrl', relationship_row.profile_pic_url
                        ) ORDER BY relationship_row.ordinal
                    )
                    FROM public.analysis_v2_relationship_rows AS relationship_row
                    WHERE relationship_row.request_id = p_request_id
                      AND relationship_row.job_key = p_job_key
                      AND relationship_row.side = 'following'
                ), '[]'::JSONB)
            ),
        'mutualRows', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'mutualOrdinal', mutual.mutual_ordinal,
                    'followingOrdinal', mutual.following_ordinal,
                    'username', mutual.username,
                    'isPrivate', mutual.is_private,
                    'isVerified', mutual.is_verified,
                    'fullName', mutual.full_name,
                    'profilePicUrl', mutual.profile_pic_url,
                    'detailedOrdinal', mutual.detailed_ordinal
                ) ORDER BY mutual.mutual_ordinal
            )
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND mutual.job_key = p_job_key
        ), '[]'::JSONB),
        'detailedPublicUsernames', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                mutual.username ORDER BY mutual.detailed_ordinal
            )
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND mutual.job_key = p_job_key
              AND mutual.detailed_ordinal IS NOT NULL
        ), '[]'::JSONB),
        'privateMutualUsernames', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                mutual.username ORDER BY mutual.mutual_ordinal
            )
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND mutual.job_key = p_job_key
              AND mutual.is_private
        ), '[]'::JSONB)
        ,
        'privateMutualRows', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'mutualOrdinal', mutual.mutual_ordinal,
                    'followingOrdinal', mutual.following_ordinal,
                    'username', mutual.username,
                    'isPrivate', mutual.is_private,
                    'isVerified', mutual.is_verified,
                    'fullName', mutual.full_name,
                    'profilePicUrl', mutual.profile_pic_url,
                    'detailedOrdinal', mutual.detailed_ordinal
                ) ORDER BY mutual.mutual_ordinal
            )
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND mutual.job_key = p_job_key
              AND mutual.is_private
        ), '[]'::JSONB)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_relationship_staging(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_relationship_staging(UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_target_evidence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_username TEXT,
    p_excluded_username TEXT,
    p_input_hash TEXT,
    p_result_hash TEXT,
    p_liker_source JSONB,
    p_comment_source JSONB,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_manifest public.analysis_v2_target_evidence_manifests%ROWTYPE;
    v_liker_provider_run public.analysis_v2_provider_runs%ROWTYPE;
    v_comment_provider_run public.analysis_v2_provider_runs%ROWTYPE;
    v_computed_hash TEXT;
    v_liker_source_hash TEXT;
    v_comment_source_hash TEXT;
    v_interactor_count INTEGER;
    v_liker_count INTEGER;
    v_comment_count INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_key <> 'track:target-evidence:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
       OR p_target_username IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_result_hash IS NULL
       OR p_result_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_target_evidence_source(
            'target_post_like', p_liker_source
       )
       OR NOT public.analysis_v2_valid_target_evidence_source(
            'target_post_comment', p_comment_source
       )
       OR NOT public.analysis_v2_valid_target_evidence_rows(
            p_rows,
            p_target_username,
            p_excluded_username
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_computed_hash := public.analysis_v2_target_evidence_result_hash(
        p_rows,
        p_liker_source,
        p_comment_source
    );
    IF v_computed_hash IS DISTINCT FROM p_result_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_interactor_count := pg_catalog.jsonb_array_length(p_rows);
    SELECT
        pg_catalog.count(*) FILTER (
            WHERE evidence.value->>'signal' = 'target_post_like'
        )::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE evidence.value->>'signal' = 'target_post_comment'
        )::INTEGER
    INTO v_liker_count, v_comment_count
    FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value);

    IF (p_liker_source->>'status' = 'not_applicable' AND v_liker_count <> 0)
       OR (p_comment_source->>'status' = 'not_applicable' AND v_comment_count <> 0)
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS evidence(value)
            WHERE NOT EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements(
                    CASE evidence.value->>'signal'
                        WHEN 'target_post_like' THEN p_liker_source->'coverage'
                        ELSE p_comment_source->'coverage'
                    END
                ) AS coverage(value)
                WHERE coverage.value->>'post_id' = evidence.value->>'post_id'
            )
       )
       OR v_liker_count > COALESCE((
            SELECT pg_catalog.sum((coverage.value->>'returned_count')::INTEGER)
            FROM pg_catalog.jsonb_array_elements(p_liker_source->'coverage') AS coverage(value)
       ), 0)
       OR v_comment_count > COALESCE((
            SELECT pg_catalog.sum((coverage.value->>'returned_count')::INTEGER)
            FROM pg_catalog.jsonb_array_elements(p_comment_source->'coverage') AS coverage(value)
       ), 0) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_liker_source_hash := public.analysis_v2_target_evidence_source_hash(
        'target_post_like', p_liker_source
    );
    v_comment_source_hash := public.analysis_v2_target_evidence_source_hash(
        'target_post_comment', p_comment_source
    );

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR pg_catalog.lower(v_request.target_instagram_id) IS DISTINCT FROM p_target_username
       OR v_request.excluded_instagram_id IS DISTINCT FROM p_excluded_username THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_NOT_ACTIVE',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.job_key <> 'track:target-evidence:collect'
       OR v_job.track <> 'target_evidence'
       OR v_job.kind <> 'collection'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF p_liker_source->>'status' = 'collected' THEN
        SELECT provider_run.*
        INTO v_liker_provider_run
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_liker_source->>'provider_operation_key'
        FOR UPDATE;
        IF NOT FOUND
           OR v_liker_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
           OR v_liker_provider_run.input_hash IS DISTINCT FROM p_liker_source->>'input_hash'
           OR v_liker_provider_run.logical_provider IS DISTINCT FROM p_liker_source->>'provider'
           OR v_liker_provider_run.run_id IS DISTINCT FROM p_liker_source->>'provider_run_id'
           OR v_liker_provider_run.credential_slot IS DISTINCT FROM
                p_liker_source->>'provider_credential_slot'
           OR v_liker_provider_run.status <> 'succeeded' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_comment_source->>'status' = 'collected' THEN
        SELECT provider_run.*
        INTO v_comment_provider_run
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_comment_source->>'provider_operation_key'
        FOR UPDATE;
        IF NOT FOUND
           OR v_comment_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
           OR v_comment_provider_run.input_hash IS DISTINCT FROM p_comment_source->>'input_hash'
           OR v_comment_provider_run.logical_provider IS DISTINCT FROM p_comment_source->>'provider'
           OR v_comment_provider_run.run_id IS DISTINCT FROM p_comment_source->>'provider_run_id'
           OR v_comment_provider_run.credential_slot IS DISTINCT FROM
                p_comment_source->>'provider_credential_slot'
           OR v_comment_provider_run.status <> 'succeeded' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT target_manifest.*
    INTO v_manifest
    FROM public.analysis_v2_target_evidence_manifests AS target_manifest
    WHERE target_manifest.request_id = p_request_id
      AND target_manifest.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF FOUND THEN
        IF v_manifest.target_username IS DISTINCT FROM p_target_username
           OR v_manifest.excluded_username IS DISTINCT FROM p_excluded_username
           OR v_manifest.input_hash IS DISTINCT FROM p_input_hash
           OR v_manifest.liker_source IS DISTINCT FROM p_liker_source
           OR v_manifest.comment_source IS DISTINCT FROM p_comment_source
           OR v_manifest.liker_source_hash IS DISTINCT FROM v_liker_source_hash
           OR v_manifest.comment_source_hash IS DISTINCT FROM v_comment_source_hash
           OR v_manifest.result_hash IS DISTINCT FROM p_result_hash
           OR v_manifest.interactor_count IS DISTINCT FROM v_interactor_count
           OR v_manifest.liker_count IS DISTINCT FROM v_liker_count
           OR v_manifest.comment_count IS DISTINCT FROM v_comment_count THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_TARGET_EVIDENCE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_target_evidence_manifests AS target_manifest
        SET job_claim_token = p_claim_token,
            updated_at = v_now
        WHERE target_manifest.request_id = p_request_id
          AND target_manifest.job_key = p_job_key
        RETURNING target_manifest.* INTO v_manifest;
        RETURN public.analysis_v2_target_evidence_manifest_json(v_manifest);
    END IF;

    INSERT INTO public.analysis_v2_target_evidence_manifests (
        request_id,
        job_key,
        job_claim_token,
        target_username,
        excluded_username,
        input_hash,
        liker_source,
        comment_source,
        liker_source_hash,
        comment_source_hash,
        result_hash,
        interactor_count,
        liker_count,
        comment_count,
        frozen_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_claim_token,
        p_target_username,
        p_excluded_username,
        p_input_hash,
        p_liker_source,
        p_comment_source,
        v_liker_source_hash,
        v_comment_source_hash,
        p_result_hash,
        v_interactor_count,
        v_liker_count,
        v_comment_count,
        v_now,
        v_now,
        v_now
    )
    RETURNING * INTO v_manifest;

    INSERT INTO public.analysis_target_interactors (
        request_id,
        job_key,
        ordinal,
        actor_username,
        post_id,
        signal,
        source_interaction_id,
        occurred_at,
        comment_text
    )
    SELECT
        p_request_id,
        p_job_key,
        evidence.ordinal::SMALLINT,
        evidence.value->>'actor_username',
        evidence.value->>'post_id',
        evidence.value->>'signal',
        evidence.value->>'source_interaction_id',
        NULLIF(evidence.value->>'occurred_at', ''),
        NULLIF(evidence.value->>'content', '')
    FROM pg_catalog.jsonb_array_elements(p_rows)
        WITH ORDINALITY AS evidence(value, ordinal)
    ORDER BY evidence.ordinal;

    RETURN public.analysis_v2_target_evidence_manifest_json(v_manifest);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_target_evidence(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_target_evidence(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_target_evidence(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_target_evidence_manifests%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = p_request_id
              AND analysis_request.pipeline_version = 'v2'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT target_manifest.*
    INTO v_manifest
    FROM public.analysis_v2_target_evidence_manifests AS target_manifest
    WHERE target_manifest.request_id = p_request_id
      AND target_manifest.job_key = p_job_key;
    IF NOT FOUND THEN RETURN NULL; END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'targetUsername', v_manifest.target_username,
        'excludedUsername', v_manifest.excluded_username,
        'manifest', public.analysis_v2_target_evidence_manifest_json(v_manifest),
        'likerSource', public.analysis_v2_target_evidence_source_json(
            v_manifest.liker_source
        ),
        'commentSource', public.analysis_v2_target_evidence_source_json(
            v_manifest.comment_source
        ),
        'rows', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'actorUsername', evidence.actor_username,
                    'postId', evidence.post_id,
                    'signal', evidence.signal,
                    'sourceInteractionId', evidence.source_interaction_id,
                    'occurredAt', evidence.occurred_at,
                    'content', evidence.comment_text
                ) ORDER BY evidence.ordinal
            )
            FROM public.analysis_target_interactors AS evidence
            WHERE evidence.request_id = p_request_id
              AND evidence.job_key = p_job_key
        ), '[]'::JSONB)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_target_evidence(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_target_evidence(UUID, TEXT)
    TO service_role;
