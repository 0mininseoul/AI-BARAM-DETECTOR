-- Phase G: immutable candidate staging, owner-readable finalized V2 results, and one
-- transaction-scoped terminal compaction boundary. Raw evidence remains service-only and is
-- removed only after every lineage/readiness check succeeds.

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_image_path(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_value IS NULL OR (
        pg_catalog.char_length(p_value) BETWEEN 9 AND 8192
        AND p_value ~ '^https://([^/@]+\.)?(instagram\.com|cdninstagram\.com|fbcdn\.net|fbsbx\.com)(:443)?/'
        AND p_value !~ '[[:cntrl:]]'
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_public_copy(
    p_value TEXT,
    p_maximum INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_value IS NOT NULL
       AND p_maximum BETWEEN 1 AND 1000
       AND pg_catalog.char_length(p_value) BETWEEN 1 AND p_maximum
       AND pg_catalog.octet_length(p_value) <= p_maximum * 4
       AND p_value ~ '[가-힣]'
       AND p_value !~ '[[:cntrl:]]'
       AND p_value !~* 'https?://|www\.'
       AND p_value !~ '@';
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_staging_hash(
    p_kind TEXT,
    p_batch INTEGER,
    p_rows JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                pg_catalog.concat_ws(
                    E'\n',
                    'analysis-v2-result-staging:v1',
                    p_kind,
                    COALESCE(p_batch::TEXT, '-'),
                    p_rows::TEXT
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_media_context(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_selection_ids TEXT[];
    v_triage_ids TEXT[];
    v_feature_ids TEXT[];
BEGIN
    IF p_value IS NULL
       OR pg_catalog.jsonb_typeof(p_value) <> 'object'
       OR NOT (p_value ?& ARRAY[
            'bundleId', 'selectionIds', 'triageAnalyzedSelectionIds',
            'featureAnalyzedSelectionIds', 'captions', 'posts'
       ])
       OR p_value - ARRAY[
            'bundleId', 'selectionIds', 'triageAnalyzedSelectionIds',
            'featureAnalyzedSelectionIds', 'captions', 'posts'
       ] <> '{}'::JSONB
       OR p_value->>'bundleId' !~ '^bundle:[a-f0-9]{64}$'
       OR pg_catalog.octet_length(p_value::TEXT) > 131072
       OR pg_catalog.jsonb_typeof(p_value->'selectionIds') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'selectionIds') NOT BETWEEN 1 AND 11
       OR pg_catalog.jsonb_typeof(p_value->'triageAnalyzedSelectionIds') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'triageAnalyzedSelectionIds') NOT BETWEEN 1 AND 5
       OR pg_catalog.jsonb_typeof(p_value->'featureAnalyzedSelectionIds') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'featureAnalyzedSelectionIds') > 11
       OR pg_catalog.jsonb_typeof(p_value->'captions') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'captions') > 10
       OR pg_catalog.jsonb_typeof(p_value->'posts') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'posts') > 8 THEN
        RETURN FALSE;
    END IF;

    SELECT pg_catalog.array_agg(selection_id.value ORDER BY selection_id.ordinality)
    INTO v_selection_ids
    FROM pg_catalog.jsonb_array_elements_text(p_value->'selectionIds')
        WITH ORDINALITY AS selection_id(value, ordinality);
    SELECT pg_catalog.array_agg(selection_id.value ORDER BY selection_id.ordinality)
    INTO v_triage_ids
    FROM pg_catalog.jsonb_array_elements_text(p_value->'triageAnalyzedSelectionIds')
        WITH ORDINALITY AS selection_id(value, ordinality);
    SELECT COALESCE(
        pg_catalog.array_agg(selection_id.value ORDER BY selection_id.ordinality),
        '{}'::TEXT[]
    )
    INTO v_feature_ids
    FROM pg_catalog.jsonb_array_elements_text(p_value->'featureAnalyzedSelectionIds')
        WITH ORDINALITY AS selection_id(value, ordinality);

    IF EXISTS (
        SELECT 1 FROM pg_catalog.unnest(v_selection_ids) AS item(value)
        WHERE item.value !~ '^[^[:cntrl:]]{1,240}$'
    ) OR pg_catalog.cardinality(v_selection_ids) <> (
        SELECT pg_catalog.count(DISTINCT item.value)
        FROM pg_catalog.unnest(v_selection_ids) AS item(value)
    ) OR NOT v_triage_ids <@ v_selection_ids
      OR NOT v_feature_ids <@ v_selection_ids
      OR pg_catalog.cardinality(v_triage_ids) <> (
        SELECT pg_catalog.count(DISTINCT item.value)
        FROM pg_catalog.unnest(v_triage_ids) AS item(value)
      ) OR pg_catalog.cardinality(v_feature_ids) <> (
        SELECT pg_catalog.count(DISTINCT item.value)
        FROM pg_catalog.unnest(v_feature_ids) AS item(value)
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_value->'captions') AS caption(value)
        WHERE pg_catalog.jsonb_typeof(caption.value) <> 'object'
           OR NOT (caption.value ?& ARRAY['evidenceRefId', 'selectionId', 'text'])
           OR caption.value - ARRAY['evidenceRefId', 'selectionId', 'text'] <> '{}'::JSONB
           OR caption.value->>'evidenceRefId' !~ '^[^[:cntrl:]]{1,240}$'
           OR caption.value->>'selectionId' !~ '^[^[:cntrl:]]{1,240}$'
           OR NOT (caption.value->>'selectionId' = ANY(v_selection_ids))
           OR pg_catalog.jsonb_typeof(caption.value->'text') <> 'string'
           OR pg_catalog.char_length(caption.value->>'text') > 2200
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_value->'posts') AS post(value)
        WHERE pg_catalog.jsonb_typeof(post.value) <> 'object'
           OR NOT (post.value ?& ARRAY['postId', 'taggedUsers', 'mentionedUsers'])
           OR post.value - ARRAY['postId', 'taggedUsers', 'mentionedUsers'] <> '{}'::JSONB
           OR post.value->>'postId' !~ '^[^[:cntrl:]]{1,255}$'
           OR pg_catalog.jsonb_typeof(post.value->'taggedUsers') <> 'array'
           OR pg_catalog.jsonb_array_length(post.value->'taggedUsers') > 50
           OR pg_catalog.jsonb_typeof(post.value->'mentionedUsers') <> 'array'
           OR pg_catalog.jsonb_array_length(post.value->'mentionedUsers') > 50
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements_text(
                    post.value->'taggedUsers' || post.value->'mentionedUsers'
                ) AS username(value)
                WHERE username.value !~ '^[a-z0-9._]{1,30}$'
           )
    ) THEN
        RETURN FALSE;
    END IF;
    RETURN TRUE;
EXCEPTION
    WHEN data_exception THEN
        RETURN FALSE;
END;
$$;

-- Replace the initial narrow feature checkpoint with the complete terminal-classification
-- envelope required for primary-join replay. Every requested profile gets one row, including an
-- explicit unavailable terminal state; only verified women retain scoring features.
CREATE OR REPLACE FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_batch INTEGER,
    p_analyzed_count INTEGER,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_rows JSONB;
    v_result_hash TEXT;
    v_existing RECORD;
BEGIN
    IF p_batch IS NULL OR p_batch NOT BETWEEN 0 AND 100000
       OR p_analyzed_count IS NULL OR p_analyzed_count NOT BETWEEN 1 AND 30
       OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) <> p_analyzed_count
       OR pg_catalog.octet_length(p_rows::TEXT) > 4194304
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImageUrl', 'bio',
                    'classification', 'mediaContext', 'genderOperationKey',
                    'genderResultHash', 'featureOperationKey', 'featureResultHash', 'feature'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImageUrl', 'bio',
                    'classification', 'mediaContext', 'genderOperationKey',
                    'genderResultHash', 'featureOperationKey', 'featureResultHash', 'feature'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
               OR item.value->>'classification' NOT IN (
                    'verified_female', 'verified_non_female', 'unresolved',
                    'unresolved_stage_conflict', 'media_unavailable', 'unavailable'
               )
               OR pg_catalog.jsonb_typeof(item.value->'fullName') NOT IN ('string', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'profileImageUrl') NOT IN ('string', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'bio') NOT IN ('string', 'null')
               OR (
                    item.value->'profileImageUrl' <> 'null'::JSONB
                    AND NOT public.analysis_v2_result_valid_image_path(
                        item.value->>'profileImageUrl'
                    )
               )
               OR (
                    item.value->>'classification' IN ('unavailable', 'media_unavailable')
                    AND (
                        item.value->'mediaContext' <> 'null'::JSONB
                        OR item.value->'genderOperationKey' <> 'null'::JSONB
                        OR item.value->'genderResultHash' <> 'null'::JSONB
                        OR item.value->'featureOperationKey' <> 'null'::JSONB
                        OR item.value->'featureResultHash' <> 'null'::JSONB
                        OR item.value->'feature' <> 'null'::JSONB
                    )
               )
               OR (
                    item.value->>'classification' NOT IN ('unavailable', 'media_unavailable')
                    AND (
                        NOT public.analysis_v2_result_valid_media_context(item.value->'mediaContext')
                        OR item.value->>'genderOperationKey'
                            !~ '^gender-triage:[a-f0-9]{64}$'
                        OR item.value->>'genderResultHash' !~ '^[a-f0-9]{64}$'
                    )
               )
               OR (
                    item.value->>'classification' IN (
                        'verified_female', 'unresolved', 'unresolved_stage_conflict'
                    )
                    AND (
                        item.value->>'featureOperationKey'
                            !~ '^feature-analysis:[a-f0-9]{64}$'
                        OR item.value->>'featureResultHash' !~ '^[a-f0-9]{64}$'
                    )
               )
               OR (
                    item.value->>'classification' = 'verified_female'
                    AND (
                        pg_catalog.jsonb_typeof(item.value->'feature') <> 'object'
                        OR NOT (item.value->'feature' ?& ARRAY[
                            'appearanceGrade', 'exposureScore', 'isBusinessAccount',
                            'featurePartnerEvidenceStrong', 'oneLineOverview'
                        ])
                        OR item.value->'feature' - ARRAY[
                            'appearanceGrade', 'exposureScore', 'isBusinessAccount',
                            'featurePartnerEvidenceStrong', 'oneLineOverview'
                        ] <> '{}'::JSONB
                        OR item.value->'feature'->>'appearanceGrade' !~ '^[1-5]$'
                        OR item.value->'feature'->>'exposureScore' !~ '^[0-5]$'
                        OR pg_catalog.jsonb_typeof(
                            item.value->'feature'->'isBusinessAccount'
                        ) <> 'boolean'
                        OR pg_catalog.jsonb_typeof(
                            item.value->'feature'->'featurePartnerEvidenceStrong'
                        ) <> 'boolean'
                        OR NOT public.analysis_v2_result_valid_public_copy(
                            item.value->'feature'->>'oneLineOverview', 180
                        )
                    )
               )
               OR (
                    item.value->>'classification' <> 'verified_female'
                    AND item.value->'feature' <> 'null'::JSONB
               )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:profile-ai:batch:' || p_batch::TEXT
       OR v_job.track <> 'profile_ai' OR v_job.kind <> 'ai'
       OR v_job.batch IS DISTINCT FROM p_batch THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO STRICT v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id;

    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_batch_topology AS topology
        WHERE topology.request_id = p_request_id
          AND topology.topology_kind = 'profile'
          AND topology.batch = p_batch
          AND topology.item_count = p_analyzed_count
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_batch_results AS batch_result
        WHERE batch_result.request_id = p_request_id
          AND batch_result.result_kind = 'profile_fetch'
          AND batch_result.batch = p_batch
          AND batch_result.item_count = p_analyzed_count
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId')
    INTO v_rows
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    IF (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId') <> p_analyzed_count
            OR pg_catalog.count(DISTINCT item.value->>'instagramId') <> p_analyzed_count
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE item.value->>'instagramId' = pg_catalog.lower(v_request.target_instagram_id)
           OR item.value->>'instagramId' = v_request.excluded_instagram_id
           OR NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND mutual.job_key = 'track:relationships:collect'
                  AND mutual.username = item.value->>'instagramId'
                  AND NOT mutual.is_private
                  AND mutual.detailed_ordinal IS NOT NULL
           )
           OR (
                item.value->>'classification' NOT IN ('unavailable', 'media_unavailable')
                AND (
                    NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                        WHERE ai_result.request_id = p_request_id
                          AND ai_result.job_key = p_job_key
                          AND ai_result.operation_key = item.value->>'genderOperationKey'
                          AND ai_result.stage = 'genderTriage'
                          AND ai_result.result_hash = item.value->>'genderResultHash'
                    )
                    OR (
                        item.value->'featureOperationKey' <> 'null'::JSONB
                        AND NOT EXISTS (
                            SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                            WHERE ai_result.request_id = p_request_id
                              AND ai_result.job_key = p_job_key
                              AND ai_result.operation_key = item.value->>'featureOperationKey'
                              AND ai_result.stage = 'featureAnalysis'
                              AND ai_result.result_hash = item.value->>'featureResultHash'
                        )
                    )
                    OR NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_media_artifacts AS artifact
                        WHERE artifact.request_id = p_request_id
                          AND artifact.artifact_kind = 'media_bundle'
                          AND artifact.artifact_key = pg_catalog.encode(
                              extensions.digest(
                                  pg_catalog.convert_to(
                                      'analysis-v2-media-bundle-key:v1' || pg_catalog.chr(10)
                                          || item.value->'mediaContext'->>'bundleId',
                                      'UTF8'
                                  ),
                                  'sha256'
                              ),
                              'hex'
                          )
                    )
                )
           )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_result_hash := public.analysis_v2_result_staging_hash(
        'profile_classifications', p_batch, v_rows
    );
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_candidate_feature_manifests AS manifest
    WHERE manifest.request_id = p_request_id AND manifest.batch = p_batch
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> p_analyzed_count
           OR v_existing.row_count <> p_analyzed_count
           OR v_existing.result_hash <> v_result_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, p_batch, p_analyzed_count,
            p_analyzed_count, v_result_hash
        );
    END IF;

    INSERT INTO public.analysis_v2_candidate_feature_manifests (
        request_id, batch, producer_job_key, producer_input_hash,
        producer_claim_token, item_count, row_count, result_hash
    ) VALUES (
        p_request_id, p_batch, p_job_key, p_job_input_hash,
        p_claim_token, p_analyzed_count, p_analyzed_count, v_result_hash
    );
    INSERT INTO public.analysis_v2_candidate_feature_rows (
        request_id, batch, candidate_id, instagram_id, full_name, profile_image_url, bio,
        terminal_classification, media_context, appearance_grade, exposure_score,
        is_business_account, feature_partner_evidence_strong, one_line_overview,
        gender_operation_key, gender_result_hash, feature_operation_key, feature_result_hash
    )
    SELECT
        p_request_id,
        p_batch,
        item.value->>'candidateId',
        item.value->>'instagramId',
        NULLIF(item.value->>'fullName', ''),
        NULLIF(item.value->>'profileImageUrl', ''),
        NULLIF(item.value->>'bio', ''),
        item.value->>'classification',
        CASE WHEN item.value->'mediaContext' = 'null'::JSONB
            THEN NULL ELSE item.value->'mediaContext' END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'appearanceGrade')::SMALLINT END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'exposureScore')::SMALLINT END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'isBusinessAccount')::BOOLEAN END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'featurePartnerEvidenceStrong')::BOOLEAN END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE item.value->'feature'->>'oneLineOverview' END,
        NULLIF(item.value->>'genderOperationKey', ''),
        NULLIF(item.value->>'genderResultHash', ''),
        NULLIF(item.value->>'featureOperationKey', ''),
        NULLIF(item.value->>'featureResultHash', '')
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);

    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, p_batch, p_analyzed_count,
        p_analyzed_count, v_result_hash
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_shortlist INTEGER;
    v_hash TEXT;
    v_existing RECORD;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 900
       OR pg_catalog.octet_length(p_rows::TEXT) > 2097152
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'components', 'preScore', 'possibleUpperBound',
                    'recentMutualRank', 'verificationShortlistRank'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'components', 'preScore', 'possibleUpperBound',
                    'recentMutualRank', 'verificationShortlistRank'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR NOT public.analysis_v2_result_valid_score_components(item.value->'components')
               OR (item.value->'components'->>'targetToCandidateLike')::NUMERIC <> 0
               OR pg_catalog.jsonb_typeof(item.value->'preScore') <> 'number'
               OR (item.value->>'preScore')::NUMERIC NOT BETWEEN 0 AND 97
               OR pg_catalog.jsonb_typeof(item.value->'possibleUpperBound') <> 'number'
               OR (item.value->>'possibleUpperBound')::NUMERIC
                    NOT BETWEEN (item.value->>'preScore')::NUMERIC
                        AND (item.value->>'preScore')::NUMERIC + 3
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE pg_catalog.abs(
                (item.value->>'preScore')::NUMERIC
                - (
                    (item.value->'components'->>'candidateToTargetLikes')::NUMERIC
                    + (item.value->'components'->>'candidateToTargetComments')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'appearanceExposure')::NUMERIC
                )
              ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'possibleUpperBound')::NUMERIC
                - LEAST((item.value->>'preScore')::NUMERIC + 3, 100)
              ) > 0.0001
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'coordinator:candidate-screening'
       OR v_job.track <> 'coordinator' OR v_job.kind <> 'screening' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'), '[]')
    INTO v_rows FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    v_shortlist := LEAST(v_count, 10);
    IF v_count <> (
        SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'verified_female'
    ) OR EXISTS (
        SELECT 1 FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'verified_female'
          AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
              WHERE item.value->>'candidateId' = feature.candidate_id
          )
    ) OR (
        SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE item.value->'verificationShortlistRank' <> 'null'::JSONB
    ) <> v_shortlist OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE (
                item.value->'recentMutualRank' <> 'null'::JSONB
                AND item.value->>'recentMutualRank' !~ '^(?:[1-9]|10)$'
              )
           OR (
                item.value->'verificationShortlistRank' <> 'null'::JSONB
                AND item.value->>'verificationShortlistRank' !~ '^(?:[1-9]|10)$'
              )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    v_hash := public.analysis_v2_result_staging_hash('preliminary_scores', NULL, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_preliminary_score_manifests AS manifest
    WHERE manifest.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> v_count OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_count, v_count, v_hash
        );
    END IF;
    INSERT INTO public.analysis_v2_preliminary_score_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        item_count, result_hash
    ) VALUES (p_request_id, p_job_key, p_job_input_hash, p_claim_token, v_count, v_hash);
    INSERT INTO public.analysis_v2_preliminary_score_rows (
        request_id, candidate_id, components, pre_score, possible_upper_bound,
        recent_mutual_rank, verification_shortlist_rank
    )
    SELECT p_request_id, item.value->>'candidateId', item.value->'components',
        (item.value->>'preScore')::NUMERIC,
        (item.value->>'possibleUpperBound')::NUMERIC,
        CASE WHEN item.value->'recentMutualRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'recentMutualRank')::SMALLINT END,
        CASE WHEN item.value->'verificationShortlistRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'verificationShortlistRank')::SMALLINT END
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);
    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_count, v_count, v_hash
    );
END;
$$;


CREATE TABLE public.analysis_v2_candidate_feature_manifests (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    batch INTEGER NOT NULL CHECK (batch BETWEEN 0 AND 100000),
    producer_job_key VARCHAR(160) NOT NULL,
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 1 AND 30),
    row_count SMALLINT NOT NULL CHECK (row_count = item_count),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, batch),
    UNIQUE (request_id, producer_job_key),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT analysis_v2_candidate_feature_manifest_job_check CHECK (
        producer_job_key = 'track:profile-ai:batch:' || batch::TEXT
    )
);

CREATE TABLE public.analysis_v2_candidate_feature_rows (
    request_id UUID NOT NULL,
    batch INTEGER NOT NULL,
    candidate_id VARCHAR(128) NOT NULL,
    instagram_id VARCHAR(30) NOT NULL,
    full_name VARCHAR(200),
    profile_image_url TEXT,
    bio VARCHAR(2200),
    terminal_classification VARCHAR(32) NOT NULL,
    media_context JSONB,
    appearance_grade SMALLINT,
    exposure_score SMALLINT,
    is_business_account BOOLEAN,
    feature_partner_evidence_strong BOOLEAN,
    one_line_overview VARCHAR(180),
    gender_operation_key VARCHAR(86),
    gender_result_hash VARCHAR(64),
    feature_operation_key VARCHAR(86),
    feature_result_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    UNIQUE (request_id, instagram_id),
    FOREIGN KEY (request_id, batch)
        REFERENCES public.analysis_v2_candidate_feature_manifests(request_id, batch)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_candidate_feature_candidate_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT analysis_v2_candidate_feature_username_check CHECK (
        instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_candidate_feature_text_check CHECK (
        (full_name IS NULL OR (
            pg_catalog.char_length(full_name) BETWEEN 1 AND 200
            AND full_name !~ '[[:cntrl:]]'
        ))
        AND (bio IS NULL OR bio !~ '[[:cntrl:]]')
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
    ),
    CONSTRAINT analysis_v2_candidate_feature_classification_check CHECK (
        terminal_classification IN (
            'verified_female', 'verified_non_female', 'unresolved',
            'unresolved_stage_conflict', 'media_unavailable', 'unavailable'
        )
        AND (
            (
                terminal_classification IN ('unavailable', 'media_unavailable')
                AND media_context IS NULL
                AND pg_catalog.num_nonnulls(
                    appearance_grade, exposure_score, is_business_account,
                    feature_partner_evidence_strong, one_line_overview,
                    gender_operation_key, gender_result_hash,
                    feature_operation_key, feature_result_hash
                ) = 0
            )
            OR (
                terminal_classification NOT IN ('unavailable', 'media_unavailable')
                AND media_context IS NOT NULL
                AND public.analysis_v2_result_valid_media_context(media_context)
                AND gender_operation_key ~ '^gender-triage:[a-f0-9]{64}$'
                AND gender_result_hash ~ '^[a-f0-9]{64}$'
                AND (
                    (
                        terminal_classification = 'verified_non_female'
                        AND (
                            (
                                feature_operation_key IS NULL
                                AND feature_result_hash IS NULL
                            )
                            OR (
                                feature_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
                                AND feature_result_hash ~ '^[a-f0-9]{64}$'
                            )
                        )
                    )
                    OR (
                        terminal_classification IN (
                            'verified_female', 'unresolved', 'unresolved_stage_conflict'
                        )
                        AND feature_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
                        AND feature_result_hash ~ '^[a-f0-9]{64}$'
                    )
                )
            )
        )
        AND (
            (
                terminal_classification = 'verified_female'
                AND appearance_grade BETWEEN 1 AND 5
                AND exposure_score BETWEEN 0 AND 5
                AND is_business_account IS NOT NULL
                AND feature_partner_evidence_strong IS NOT NULL
                AND public.analysis_v2_result_valid_public_copy(one_line_overview, 180)
            )
            OR (
                terminal_classification <> 'verified_female'
                AND pg_catalog.num_nonnulls(
                    appearance_grade, exposure_score, is_business_account,
                    feature_partner_evidence_strong, one_line_overview
                ) = 0
            )
        )
    )
);

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_score_components(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_value IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_value) = 'object'
       AND p_value ?& ARRAY[
            'candidateToTargetLikes', 'candidateToTargetComments',
            'targetToCandidateLike', 'tagOrCaptionMention',
            'recentMutual', 'appearanceExposure'
       ]
       AND p_value - ARRAY[
            'candidateToTargetLikes', 'candidateToTargetComments',
            'targetToCandidateLike', 'tagOrCaptionMention',
            'recentMutual', 'appearanceExposure'
       ] = '{}'::JSONB
       AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetLikes') = 'number'
       AND (p_value->>'candidateToTargetLikes')::NUMERIC BETWEEN 0 AND 20
       AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetComments') = 'number'
       AND (p_value->>'candidateToTargetComments')::NUMERIC BETWEEN 0 AND 26
       AND pg_catalog.jsonb_typeof(p_value->'targetToCandidateLike') = 'number'
       AND (p_value->>'targetToCandidateLike')::NUMERIC BETWEEN 0 AND 3
       AND pg_catalog.jsonb_typeof(p_value->'tagOrCaptionMention') = 'number'
       AND (p_value->>'tagOrCaptionMention')::NUMERIC BETWEEN 0 AND 14
       AND pg_catalog.jsonb_typeof(p_value->'recentMutual') = 'number'
       AND (p_value->>'recentMutual')::NUMERIC BETWEEN 0 AND 17
       AND pg_catalog.jsonb_typeof(p_value->'appearanceExposure') = 'number'
       AND (p_value->>'appearanceExposure')::NUMERIC BETWEEN 0 AND 20;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_ref_list(
    p_values TEXT[],
    p_maximum INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_values IS NOT NULL
       AND p_maximum BETWEEN 0 AND 100
       AND pg_catalog.cardinality(p_values) <= p_maximum
       AND pg_catalog.cardinality(p_values) = (
            SELECT pg_catalog.count(DISTINCT item.value)
            FROM pg_catalog.unnest(p_values) AS item(value)
       )
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(p_values) AS item(value)
            WHERE item.value !~ '^[^[:cntrl:]]{1,240}$'
       );
$$;

CREATE TABLE public.analysis_v2_preliminary_score_manifests (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    producer_job_key VARCHAR(160) NOT NULL CHECK (
        producer_job_key = 'coordinator:candidate-screening'
    ),
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 0 AND 900),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE TABLE public.analysis_v2_preliminary_score_rows (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_preliminary_score_manifests(request_id)
        ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    components JSONB NOT NULL CHECK (
        public.analysis_v2_result_valid_score_components(components)
        AND (components->>'targetToCandidateLike')::NUMERIC = 0
    ),
    pre_score NUMERIC(8, 4) NOT NULL CHECK (pre_score BETWEEN 0 AND 97),
    possible_upper_bound NUMERIC(8, 4) NOT NULL CHECK (
        possible_upper_bound BETWEEN pre_score AND pre_score + 3
        AND possible_upper_bound <= 100
    ),
    recent_mutual_rank SMALLINT CHECK (recent_mutual_rank BETWEEN 1 AND 10),
    verification_shortlist_rank SMALLINT CHECK (
        verification_shortlist_rank BETWEEN 1 AND 10
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    FOREIGN KEY (request_id, candidate_id)
        REFERENCES public.analysis_v2_candidate_feature_rows(request_id, candidate_id)
);
CREATE UNIQUE INDEX idx_analysis_v2_preliminary_recent_rank
    ON public.analysis_v2_preliminary_score_rows(request_id, recent_mutual_rank)
    WHERE recent_mutual_rank IS NOT NULL;
CREATE UNIQUE INDEX idx_analysis_v2_preliminary_shortlist_rank
    ON public.analysis_v2_preliminary_score_rows(request_id, verification_shortlist_rank)
    WHERE verification_shortlist_rank IS NOT NULL;

CREATE TABLE public.analysis_v2_reverse_like_manifests (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    producer_job_key VARCHAR(160) NOT NULL CHECK (
        producer_job_key = 'track:reverse-likes:collect'
    ),
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 0 AND 900),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE TABLE public.analysis_v2_reverse_like_rows (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_reverse_like_manifests(request_id)
        ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    reverse_like_status VARCHAR(16) NOT NULL CHECK (
        reverse_like_status IN ('observed', 'not_observed', 'not_collected')
    ),
    component_score NUMERIC(3, 1) NOT NULL CHECK (component_score IN (0, 3)),
    evidence_ref_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    FOREIGN KEY (request_id, candidate_id)
        REFERENCES public.analysis_v2_preliminary_score_rows(request_id, candidate_id),
    CONSTRAINT analysis_v2_reverse_like_evidence_check CHECK (
        public.analysis_v2_result_valid_ref_list(evidence_ref_ids, 8)
        AND (
            (
                reverse_like_status = 'observed'
                AND component_score = 3
                AND pg_catalog.cardinality(evidence_ref_ids) > 0
            )
            OR (
                reverse_like_status <> 'observed'
                AND component_score = 0
                AND pg_catalog.cardinality(evidence_ref_ids) = 0
            )
        )
    )
);

CREATE TABLE public.analysis_v2_partner_safety_manifests (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    producer_job_key VARCHAR(160) NOT NULL CHECK (
        producer_job_key = 'track:partner-safety:batch:0'
    ),
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 0 AND 900),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE TABLE public.analysis_v2_partner_safety_rows (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_partner_safety_manifests(request_id)
        ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    source VARCHAR(24) NOT NULL CHECK (
        source IN ('not_collected', 'feature_only', 'gemini', 'safe_fallback')
    ),
    has_strong_partner_evidence BOOLEAN NOT NULL,
    has_weak_partner_evidence BOOLEAN NOT NULL,
    strong_evidence_basis VARCHAR(24) NOT NULL CHECK (
        strong_evidence_basis IN ('none', 'feature', 'contact_sheet', 'both')
    ),
    evidence_selection_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    bundle_id VARCHAR(71),
    operation_key VARCHAR(86),
    ai_result_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    FOREIGN KEY (request_id, candidate_id)
        REFERENCES public.analysis_v2_preliminary_score_rows(request_id, candidate_id),
    CONSTRAINT analysis_v2_partner_safety_evidence_check CHECK (
        public.analysis_v2_result_valid_ref_list(evidence_selection_ids, 8)
        AND (has_strong_partner_evidence = (strong_evidence_basis <> 'none'))
        AND NOT (has_strong_partner_evidence AND has_weak_partner_evidence)
        AND (
            (
                source = 'gemini'
                AND bundle_id ~ '^bundle:[a-f0-9]{64}$'
                AND operation_key ~ '^partner-safety:[a-f0-9]{64}$'
                AND ai_result_hash ~ '^[a-f0-9]{64}$'
            )
            OR (
                source = 'safe_fallback'
                AND bundle_id ~ '^bundle:[a-f0-9]{64}$'
                AND operation_key ~ '^partner-safety:[a-f0-9]{64}$'
                AND ai_result_hash IS NULL
            )
            OR (
                source IN ('not_collected', 'feature_only')
                AND bundle_id IS NULL
                AND operation_key IS NULL
                AND ai_result_hash IS NULL
            )
        )
    )
);

CREATE TABLE public.analysis_v2_candidate_score_manifests (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    producer_job_key VARCHAR(160) NOT NULL CHECK (
        producer_job_key = 'coordinator:join:final-score'
    ),
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    risk_policy_version VARCHAR(64) NOT NULL CHECK (
        risk_policy_version = 'risk-policy-v2.2'
    ),
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 0 AND 900),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE TABLE public.analysis_v2_candidate_score_rows (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_candidate_score_manifests(request_id)
        ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    display_score NUMERIC(3, 1) NOT NULL,
    risk_band VARCHAR(16) NOT NULL,
    featured_rank SMALLINT,
    recent_mutual_rank SMALLINT,
    verification_shortlist_rank SMALLINT,
    partner_safety_source VARCHAR(24) NOT NULL,
    partner_safety_operation_key VARCHAR(86),
    partner_safety_result_hash VARCHAR(64),
    components JSONB NOT NULL CHECK (
        public.analysis_v2_result_valid_score_components(components)
    ),
    weak_partner_adjustment NUMERIC(3, 1) NOT NULL CHECK (
        weak_partner_adjustment IN (-5, 0)
    ),
    pre_score NUMERIC(8, 4) NOT NULL CHECK (pre_score BETWEEN 0 AND 97),
    raw_score NUMERIC(8, 4) NOT NULL CHECK (raw_score BETWEEN 0 AND 100),
    possible_upper_bound NUMERIC(8, 4) NOT NULL CHECK (
        possible_upper_bound BETWEEN raw_score AND 100
    ),
    public_score NUMERIC(8, 4) NOT NULL CHECK (public_score BETWEEN 1 AND 10),
    possible_upper_public_score NUMERIC(8, 4) NOT NULL CHECK (
        possible_upper_public_score BETWEEN public_score AND 10
    ),
    partner_cap_applied BOOLEAN NOT NULL,
    partner_evidence_selection_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    FOREIGN KEY (request_id, candidate_id)
        REFERENCES public.analysis_v2_candidate_feature_rows(request_id, candidate_id),
    CONSTRAINT analysis_v2_candidate_score_candidate_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT analysis_v2_candidate_score_band_check CHECK (
        display_score BETWEEN 1.0 AND 10.0
        AND risk_band IN ('normal', 'caution', 'high_risk')
        AND (
            (display_score < 4.2 AND risk_band = 'normal')
            OR (display_score = 4.2 AND risk_band IN ('normal', 'caution'))
            OR (display_score > 4.2 AND display_score < 6.8 AND risk_band = 'caution')
            OR (display_score = 6.8 AND risk_band IN ('caution', 'high_risk'))
            OR (display_score > 6.8 AND risk_band = 'high_risk')
        )
    ),
    CONSTRAINT analysis_v2_candidate_score_featured_check CHECK (
        (risk_band = 'normal' AND featured_rank IS NULL)
        OR (risk_band = 'caution' AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 15))
        OR (risk_band = 'high_risk' AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 3))
    ),
    CONSTRAINT analysis_v2_candidate_score_rank_check CHECK (
        (recent_mutual_rank IS NULL OR recent_mutual_rank BETWEEN 1 AND 10)
        AND (
            verification_shortlist_rank IS NULL
            OR verification_shortlist_rank BETWEEN 1 AND 10
        )
    ),
    CONSTRAINT analysis_v2_candidate_score_partner_check CHECK (
        partner_safety_source IN (
            'not_collected', 'feature_only', 'gemini', 'safe_fallback'
        )
        AND (
            (
                partner_safety_source = 'gemini'
                AND partner_safety_operation_key ~ '^partner-safety:[a-f0-9]{64}$'
                AND partner_safety_result_hash ~ '^[a-f0-9]{64}$'
            )
            OR (
                partner_safety_source = 'safe_fallback'
                AND partner_safety_operation_key ~ '^partner-safety:[a-f0-9]{64}$'
                AND partner_safety_result_hash IS NULL
            )
            OR (
                partner_safety_source IN ('not_collected', 'feature_only')
                AND partner_safety_operation_key IS NULL
                AND partner_safety_result_hash IS NULL
            )
        )
        AND (
            (verification_shortlist_rank IS NULL AND partner_safety_source = 'not_collected')
            OR verification_shortlist_rank IS NOT NULL
        )
        AND public.analysis_v2_result_valid_ref_list(partner_evidence_selection_ids, 8)
    )
);

CREATE UNIQUE INDEX idx_analysis_v2_candidate_score_featured_rank
    ON public.analysis_v2_candidate_score_rows(request_id, risk_band, featured_rank)
    WHERE featured_rank IS NOT NULL;
CREATE UNIQUE INDEX idx_analysis_v2_candidate_score_recent_rank
    ON public.analysis_v2_candidate_score_rows(request_id, recent_mutual_rank)
    WHERE recent_mutual_rank IS NOT NULL;
CREATE UNIQUE INDEX idx_analysis_v2_candidate_score_shortlist_rank
    ON public.analysis_v2_candidate_score_rows(request_id, verification_shortlist_rank)
    WHERE verification_shortlist_rank IS NOT NULL;

CREATE TABLE public.analysis_v2_private_name_manifests (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    batch INTEGER NOT NULL CHECK (batch BETWEEN 0 AND 100000),
    producer_job_key VARCHAR(160) NOT NULL,
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 1 AND 100),
    source VARCHAR(16) NOT NULL CHECK (source IN ('checkpoint', 'safe_fallback')),
    operation_key VARCHAR(86) NOT NULL CHECK (
        operation_key ~ '^private-account-name:[a-f0-9]{64}$'
    ),
    ai_result_hash VARCHAR(64),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, batch),
    UNIQUE (request_id, producer_job_key),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT analysis_v2_private_manifest_job_check CHECK (
        producer_job_key = 'track:private-names:batch:' || batch::TEXT
    ),
    CONSTRAINT analysis_v2_private_manifest_ai_check CHECK (
        (source = 'checkpoint' AND ai_result_hash ~ '^[a-f0-9]{64}$')
        OR (source = 'safe_fallback' AND ai_result_hash IS NULL)
    )
);

CREATE TABLE public.analysis_v2_private_name_rows (
    request_id UUID NOT NULL,
    batch INTEGER NOT NULL,
    candidate_id VARCHAR(128) NOT NULL,
    instagram_id VARCHAR(30) NOT NULL,
    full_name VARCHAR(200),
    profile_image_url TEXT,
    name_female_score NUMERIC(5, 4) NOT NULL,
    name_is_name BOOLEAN NOT NULL,
    name_confidence NUMERIC(5, 4) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    UNIQUE (request_id, instagram_id),
    FOREIGN KEY (request_id, batch)
        REFERENCES public.analysis_v2_private_name_manifests(request_id, batch)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_private_row_candidate_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT analysis_v2_private_row_username_check CHECK (
        instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_private_row_text_check CHECK (
        (full_name IS NULL OR (
            pg_catalog.char_length(full_name) BETWEEN 1 AND 200
            AND full_name !~ '[[:cntrl:]]'
        ))
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
    ),
    CONSTRAINT analysis_v2_private_row_score_check CHECK (
        name_female_score BETWEEN 0 AND 1
        AND name_confidence BETWEEN 0 AND 1
        AND (name_is_name OR name_female_score = 0.5)
    )
);

CREATE TABLE public.analysis_v2_narrative_manifests (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    producer_job_key VARCHAR(160) NOT NULL CHECK (
        producer_job_key = 'track:narratives:batch:0'
    ),
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    producer_claim_token UUID NOT NULL,
    item_count SMALLINT NOT NULL CHECK (item_count BETWEEN 0 AND 3),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE TABLE public.analysis_v2_narrative_rows (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_narrative_manifests(request_id)
        ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    line_one VARCHAR(180) NOT NULL,
    line_two VARCHAR(180) NOT NULL,
    source VARCHAR(16) NOT NULL CHECK (source IN ('checkpoint', 'safe_fallback')),
    operation_key VARCHAR(86) NOT NULL CHECK (
        operation_key ~ '^high-risk-narrative:[a-f0-9]{64}$'
    ),
    ai_result_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    CONSTRAINT analysis_v2_narrative_row_candidate_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT analysis_v2_narrative_row_copy_check CHECK (
        public.analysis_v2_result_valid_public_copy(line_one, 180)
        AND public.analysis_v2_result_valid_public_copy(line_two, 180)
    ),
    CONSTRAINT analysis_v2_narrative_row_ai_check CHECK (
        (source = 'checkpoint' AND ai_result_hash ~ '^[a-f0-9]{64}$')
        OR (source = 'safe_fallback' AND ai_result_hash IS NULL)
    )
);

CREATE TABLE public.analysis_v2_result_summaries (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    target_instagram_id VARCHAR(30) NOT NULL,
    target_profile_image_url TEXT,
    plan_id VARCHAR(16) NOT NULL CHECK (plan_id IN ('basic', 'standard', 'plus')),
    followers_declared SMALLINT NOT NULL,
    followers_collected SMALLINT NOT NULL,
    following_declared SMALLINT NOT NULL,
    following_collected SMALLINT NOT NULL,
    detected_mutuals SMALLINT NOT NULL,
    public_mutuals SMALLINT NOT NULL,
    private_mutuals SMALLINT NOT NULL,
    screened_mutuals SMALLINT NOT NULL,
    not_screened_mutuals SMALLINT NOT NULL,
    fetch_unavailable_count SMALLINT NOT NULL,
    media_unavailable_count SMALLINT NOT NULL,
    exclusion_applied BOOLEAN NOT NULL,
    score_policy_version VARCHAR(64) NOT NULL CHECK (
        score_policy_version = 'risk-policy-v2.2'
    ),
    finalizer_input_hash VARCHAR(64) NOT NULL CHECK (
        finalizer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_result_summary_username_check CHECK (
        target_instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_result_summary_image_check CHECK (
        public.analysis_v2_result_valid_image_path(target_profile_image_url)
    ),
    CONSTRAINT analysis_v2_result_summary_coverage_check CHECK (
        followers_declared BETWEEN 0 AND 1200
        AND followers_collected BETWEEN 0 AND followers_declared
        AND following_declared BETWEEN 0 AND 1200
        AND following_collected BETWEEN 0 AND following_declared
        AND (
            (followers_declared = 0 AND followers_collected = 0)
            OR followers_collected * 100 >= followers_declared * 99
        )
        AND (
            (following_declared = 0 AND following_collected = 0)
            OR following_collected * 100 >= following_declared * 99
        )
    ),
    CONSTRAINT analysis_v2_result_summary_count_check CHECK (
        detected_mutuals BETWEEN 0 AND 1200
        AND public_mutuals BETWEEN 0 AND detected_mutuals
        AND private_mutuals BETWEEN 0 AND detected_mutuals
        AND public_mutuals + private_mutuals = detected_mutuals
        AND screened_mutuals BETWEEN 0 AND public_mutuals
        AND not_screened_mutuals = public_mutuals - screened_mutuals
        AND fetch_unavailable_count BETWEEN 0 AND screened_mutuals
        AND media_unavailable_count BETWEEN 0 AND screened_mutuals
        AND fetch_unavailable_count + media_unavailable_count <= screened_mutuals
        AND detected_mutuals <= followers_collected
        AND detected_mutuals <= following_collected
    )
);

CREATE TABLE public.analysis_v2_female_results (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_result_summaries(request_id) ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    sort_ordinal SMALLINT NOT NULL CHECK (sort_ordinal BETWEEN 1 AND 900),
    instagram_id VARCHAR(30) NOT NULL,
    full_name VARCHAR(200),
    profile_image_url TEXT,
    bio VARCHAR(2200),
    display_score NUMERIC(3, 1) NOT NULL,
    risk_band VARCHAR(16) NOT NULL,
    featured_rank SMALLINT,
    recent_mutual_rank SMALLINT,
    analysis_depth VARCHAR(16) NOT NULL,
    one_line_overview VARCHAR(180) NOT NULL,
    narrative_line_one VARCHAR(180),
    narrative_line_two VARCHAR(180),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    UNIQUE (request_id, sort_ordinal),
    UNIQUE (request_id, instagram_id),
    CONSTRAINT analysis_v2_female_result_identity_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_female_result_text_check CHECK (
        (full_name IS NULL OR (
            pg_catalog.char_length(full_name) BETWEEN 1 AND 200
            AND full_name !~ '[[:cntrl:]]'
        ))
        AND (bio IS NULL OR bio !~ '[[:cntrl:]]')
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
        AND public.analysis_v2_result_valid_public_copy(one_line_overview, 180)
    ),
    CONSTRAINT analysis_v2_female_result_score_check CHECK (
        display_score BETWEEN 1.0 AND 10.0
        AND risk_band IN ('normal', 'caution', 'high_risk')
        AND (
            (display_score < 4.2 AND risk_band = 'normal')
            OR (display_score = 4.2 AND risk_band IN ('normal', 'caution'))
            OR (display_score > 4.2 AND display_score < 6.8 AND risk_band = 'caution')
            OR (display_score = 6.8 AND risk_band IN ('caution', 'high_risk'))
            OR (display_score > 6.8 AND risk_band = 'high_risk')
        )
        AND (
            (risk_band = 'normal' AND featured_rank IS NULL)
            OR (risk_band = 'caution' AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 15))
            OR (risk_band = 'high_risk' AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 3))
        )
        AND (recent_mutual_rank IS NULL OR recent_mutual_rank BETWEEN 1 AND 10)
    ),
    CONSTRAINT analysis_v2_female_result_narrative_check CHECK (
        (
            risk_band = 'high_risk'
            AND featured_rank BETWEEN 1 AND 3
            AND analysis_depth = 'narrative'
            AND public.analysis_v2_result_valid_public_copy(narrative_line_one, 180)
            AND public.analysis_v2_result_valid_public_copy(narrative_line_two, 180)
        )
        OR (
            NOT (risk_band = 'high_risk' AND featured_rank BETWEEN 1 AND 3)
            AND analysis_depth = 'features'
            AND narrative_line_one IS NULL
            AND narrative_line_two IS NULL
        )
    )
);

CREATE TABLE public.analysis_v2_private_results (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_result_summaries(request_id) ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    sort_ordinal SMALLINT NOT NULL CHECK (sort_ordinal BETWEEN 1 AND 1200),
    instagram_id VARCHAR(30) NOT NULL,
    full_name VARCHAR(200),
    profile_image_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    UNIQUE (request_id, sort_ordinal),
    UNIQUE (request_id, instagram_id),
    CONSTRAINT analysis_v2_private_result_identity_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
        AND instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_private_result_text_check CHECK (
        (full_name IS NULL OR (
            pg_catalog.char_length(full_name) BETWEEN 1 AND 200
            AND full_name !~ '[[:cntrl:]]'
        ))
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
    )
);

CREATE INDEX idx_analysis_v2_female_results_order
    ON public.analysis_v2_female_results(request_id, sort_ordinal, candidate_id);
CREATE INDEX idx_analysis_v2_private_results_order
    ON public.analysis_v2_private_results(request_id, sort_ordinal, candidate_id);

ALTER TABLE public.analysis_v2_candidate_feature_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_feature_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_feature_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_feature_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_preliminary_score_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_preliminary_score_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_preliminary_score_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_preliminary_score_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_reverse_like_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_reverse_like_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_reverse_like_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_reverse_like_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_partner_safety_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_partner_safety_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_partner_safety_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_partner_safety_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_score_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_score_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_score_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_candidate_score_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_private_name_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_private_name_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_private_name_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_private_name_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_narrative_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_narrative_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_narrative_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_narrative_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_summaries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_female_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_female_results FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_private_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_private_results FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_v2_candidate_feature_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_candidate_feature_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_preliminary_score_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_preliminary_score_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_reverse_like_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_reverse_like_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_partner_safety_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_partner_safety_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_candidate_score_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_candidate_score_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_private_name_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_private_name_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_narrative_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_narrative_rows
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_result_summaries
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_female_results
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_private_results
    FROM PUBLIC, anon, authenticated, service_role;

-- Final tables retain canonical upstream media URLs so the server can mint a fresh short-lived
-- proxy signature on every result read. They are deliberately RPC/API-only; no client role can
-- SELECT a raw provider URL or mutate a finalized row.

CREATE OR REPLACE FUNCTION public.analysis_v2_assert_result_job_fence(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS public.analysis_pipeline_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing')
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_checkpoint_json(
    p_request_id UUID,
    p_job_key TEXT,
    p_batch INTEGER,
    p_item_count INTEGER,
    p_row_count INTEGER,
    p_result_hash TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'batch', p_batch,
        'itemCount', p_item_count,
        'rowCount', p_row_count,
        'resultHash', p_result_hash
    );
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_features(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_batch INTEGER,
    p_analyzed_count INTEGER,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_rows JSONB;
    v_result_hash TEXT;
    v_row_count INTEGER;
    v_existing public.analysis_v2_candidate_feature_manifests%ROWTYPE;
BEGIN
    IF p_batch IS NULL
       OR p_batch NOT BETWEEN 0 AND 100000
       OR p_analyzed_count IS NULL
       OR p_analyzed_count NOT BETWEEN 1 AND 30
       OR p_rows IS NULL
       OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > p_analyzed_count
       OR pg_catalog.octet_length(p_rows::TEXT) > 1048576
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS row_data(value)
            WHERE pg_catalog.jsonb_typeof(row_data.value) <> 'object'
               OR NOT (row_data.value ?& ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImage', 'bio',
                    'appearanceGrade', 'exposureScore', 'isBusinessAccount',
                    'featurePartnerEvidenceStrong', 'oneLineOverview',
                    'genderOperationKey', 'genderResultHash',
                    'featureOperationKey', 'featureResultHash'
               ])
               OR row_data.value - ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImage', 'bio',
                    'appearanceGrade', 'exposureScore', 'isBusinessAccount',
                    'featurePartnerEvidenceStrong', 'oneLineOverview',
                    'genderOperationKey', 'genderResultHash',
                    'featureOperationKey', 'featureResultHash'
               ] <> '{}'::JSONB
               OR row_data.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR row_data.value->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
               OR pg_catalog.jsonb_typeof(row_data.value->'appearanceGrade') <> 'number'
               OR row_data.value->>'appearanceGrade' !~ '^[1-5]$'
               OR pg_catalog.jsonb_typeof(row_data.value->'exposureScore') <> 'number'
               OR row_data.value->>'exposureScore' !~ '^[0-5]$'
               OR pg_catalog.jsonb_typeof(row_data.value->'isBusinessAccount') <> 'boolean'
               OR pg_catalog.jsonb_typeof(
                    row_data.value->'featurePartnerEvidenceStrong'
               ) <> 'boolean'
               OR NOT public.analysis_v2_result_valid_public_copy(
                    row_data.value->>'oneLineOverview', 180
               )
               OR row_data.value->>'genderOperationKey'
                    !~ '^gender-triage:[a-f0-9]{64}$'
               OR row_data.value->>'featureOperationKey'
                    !~ '^feature-analysis:[a-f0-9]{64}$'
               OR row_data.value->>'genderResultHash' !~ '^[a-f0-9]{64}$'
               OR row_data.value->>'featureResultHash' !~ '^[a-f0-9]{64}$'
               OR (
                    pg_catalog.jsonb_typeof(row_data.value->'fullName') NOT IN ('string', 'null')
                    OR (
                        pg_catalog.jsonb_typeof(row_data.value->'fullName') = 'string'
                        AND (
                            pg_catalog.char_length(row_data.value->>'fullName') NOT BETWEEN 1 AND 200
                            OR row_data.value->>'fullName' ~ '[[:cntrl:]]'
                        )
                    )
               )
               OR (
                    pg_catalog.jsonb_typeof(row_data.value->'profileImage') NOT IN ('string', 'null')
                    OR NOT public.analysis_v2_result_valid_image_path(
                        CASE WHEN row_data.value->'profileImage' = 'null'::JSONB
                            THEN NULL ELSE row_data.value->>'profileImage' END
                    )
               )
               OR (
                    pg_catalog.jsonb_typeof(row_data.value->'bio') NOT IN ('string', 'null')
                    OR (
                        pg_catalog.jsonb_typeof(row_data.value->'bio') = 'string'
                        AND (
                            pg_catalog.char_length(row_data.value->>'bio') > 2200
                            OR row_data.value->>'bio' ~ '[[:cntrl:]]'
                        )
                    )
               )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:profile-ai:batch:' || p_batch::TEXT
       OR v_job.track <> 'profile_ai'
       OR v_job.kind <> 'ai'
       OR v_job.batch IS DISTINCT FROM p_batch THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO STRICT v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id;

    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_v2_dag_batch_topology AS topology
        WHERE topology.request_id = p_request_id
          AND topology.topology_kind = 'profile'
          AND topology.batch = p_batch
          AND topology.item_count = p_analyzed_count
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.analysis_v2_dag_batch_results AS batch_result
        WHERE batch_result.request_id = p_request_id
          AND batch_result.result_kind = 'profile_fetch'
          AND batch_result.batch = p_batch
          AND batch_result.item_count = p_analyzed_count
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'candidateId', row_data.value->>'candidateId',
            'instagramId', row_data.value->>'instagramId',
            'fullName', row_data.value->'fullName',
            'profileImage', row_data.value->'profileImage',
            'bio', row_data.value->'bio',
            'appearanceGrade', (row_data.value->>'appearanceGrade')::INTEGER,
            'exposureScore', (row_data.value->>'exposureScore')::INTEGER,
            'isBusinessAccount', (row_data.value->>'isBusinessAccount')::BOOLEAN,
            'featurePartnerEvidenceStrong',
                (row_data.value->>'featurePartnerEvidenceStrong')::BOOLEAN,
            'oneLineOverview', row_data.value->>'oneLineOverview',
            'genderOperationKey', row_data.value->>'genderOperationKey',
            'genderResultHash', row_data.value->>'genderResultHash',
            'featureOperationKey', row_data.value->>'featureOperationKey',
            'featureResultHash', row_data.value->>'featureResultHash'
        ) ORDER BY row_data.value->>'candidateId'
    ), '[]'::JSONB)
    INTO v_rows
    FROM pg_catalog.jsonb_array_elements(p_rows) AS row_data(value);
    v_row_count := pg_catalog.jsonb_array_length(v_rows);

    IF (
        SELECT pg_catalog.count(DISTINCT row_data.value->>'candidateId') <> v_row_count
            OR pg_catalog.count(DISTINCT row_data.value->>'instagramId') <> v_row_count
        FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value)
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value)
        WHERE row_data.value->>'instagramId' = pg_catalog.lower(v_request.target_instagram_id)
           OR row_data.value->>'instagramId' = v_request.excluded_instagram_id
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND mutual.job_key = 'track:relationships:collect'
                  AND mutual.username = row_data.value->>'instagramId'
                  AND NOT mutual.is_private
                  AND mutual.detailed_ordinal IS NOT NULL
           )
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                WHERE ai_result.request_id = p_request_id
                  AND ai_result.job_key = p_job_key
                  AND ai_result.operation_key = row_data.value->>'genderOperationKey'
                  AND ai_result.stage = 'genderTriage'
                  AND ai_result.result_hash = row_data.value->>'genderResultHash'
           )
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                WHERE ai_result.request_id = p_request_id
                  AND ai_result.job_key = p_job_key
                  AND ai_result.operation_key = row_data.value->>'featureOperationKey'
                  AND ai_result.stage = 'featureAnalysis'
                  AND ai_result.result_hash = row_data.value->>'featureResultHash'
           )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_result_hash := public.analysis_v2_result_staging_hash(
        'candidate_features', p_batch, v_rows
    );
    SELECT manifest.*
    INTO v_existing
    FROM public.analysis_v2_candidate_feature_manifests AS manifest
    WHERE manifest.request_id = p_request_id AND manifest.batch = p_batch
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> p_analyzed_count
           OR v_existing.row_count <> v_row_count
           OR v_existing.result_hash <> v_result_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, p_batch, p_analyzed_count,
            v_row_count, v_result_hash
        );
    END IF;

    INSERT INTO public.analysis_v2_candidate_feature_manifests (
        request_id, batch, producer_job_key, producer_input_hash,
        producer_claim_token, item_count, row_count, result_hash
    ) VALUES (
        p_request_id, p_batch, p_job_key, p_job_input_hash,
        p_claim_token, p_analyzed_count, v_row_count, v_result_hash
    );
    INSERT INTO public.analysis_v2_candidate_feature_rows (
        request_id, batch, candidate_id, instagram_id, full_name, profile_image, bio,
        appearance_grade, exposure_score, is_business_account,
        feature_partner_evidence_strong, one_line_overview,
        gender_operation_key, gender_result_hash,
        feature_operation_key, feature_result_hash
    )
    SELECT
        p_request_id,
        p_batch,
        row_data.value->>'candidateId',
        row_data.value->>'instagramId',
        CASE WHEN row_data.value->'fullName' = 'null'::JSONB
            THEN NULL ELSE row_data.value->>'fullName' END,
        CASE WHEN row_data.value->'profileImage' = 'null'::JSONB
            THEN NULL ELSE row_data.value->>'profileImage' END,
        CASE WHEN row_data.value->'bio' = 'null'::JSONB
            THEN NULL ELSE row_data.value->>'bio' END,
        (row_data.value->>'appearanceGrade')::SMALLINT,
        (row_data.value->>'exposureScore')::SMALLINT,
        (row_data.value->>'isBusinessAccount')::BOOLEAN,
        (row_data.value->>'featurePartnerEvidenceStrong')::BOOLEAN,
        row_data.value->>'oneLineOverview',
        row_data.value->>'genderOperationKey',
        row_data.value->>'genderResultHash',
        row_data.value->>'featureOperationKey',
        row_data.value->>'featureResultHash'
    FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value);

    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, p_batch, p_analyzed_count,
        v_row_count, v_result_hash
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB,
    p_risk_policy_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_result_hash TEXT;
    v_row_count INTEGER;
    v_expected_shortlist INTEGER;
    v_existing public.analysis_v2_candidate_score_manifests%ROWTYPE;
BEGIN
    IF p_risk_policy_version <> 'risk-policy-v2.2'
       OR p_rows IS NULL
       OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 900
       OR pg_catalog.octet_length(p_rows::TEXT) > 1048576
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS row_data(value)
            WHERE pg_catalog.jsonb_typeof(row_data.value) <> 'object'
               OR NOT (row_data.value ?& ARRAY[
                    'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                    'recentMutualRank', 'verificationShortlistRank',
                    'partnerSafetySource', 'partnerSafetyOperationKey',
                    'partnerSafetyResultHash'
               ])
               OR row_data.value - ARRAY[
                    'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                    'recentMutualRank', 'verificationShortlistRank',
                    'partnerSafetySource', 'partnerSafetyOperationKey',
                    'partnerSafetyResultHash'
               ] <> '{}'::JSONB
               OR row_data.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR pg_catalog.jsonb_typeof(row_data.value->'displayScore') <> 'number'
               OR row_data.value->>'displayScore' !~ '^(10(?:\.0)?|[1-9](?:\.[0-9])?)$'
               OR row_data.value->>'riskBand' NOT IN ('normal', 'caution', 'high_risk')
               OR row_data.value->>'partnerSafetySource' NOT IN (
                    'not_collected', 'feature_only', 'gemini', 'safe_fallback'
               )
               OR pg_catalog.jsonb_typeof(row_data.value->'featuredRank')
                    NOT IN ('number', 'null')
               OR pg_catalog.jsonb_typeof(row_data.value->'recentMutualRank')
                    NOT IN ('number', 'null')
               OR pg_catalog.jsonb_typeof(row_data.value->'verificationShortlistRank')
                    NOT IN ('number', 'null')
               OR pg_catalog.jsonb_typeof(row_data.value->'partnerSafetyOperationKey')
                    NOT IN ('string', 'null')
               OR pg_catalog.jsonb_typeof(row_data.value->'partnerSafetyResultHash')
                    NOT IN ('string', 'null')
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'coordinator:join:final-score'
       OR v_job.track <> 'coordinator'
       OR v_job.kind <> 'join'
       OR v_job.batch IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.policy_versions_snapshot->>'risk' = p_risk_policy_version
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'candidateId', row_data.value->>'candidateId',
            'displayScore', (row_data.value->>'displayScore')::NUMERIC,
            'riskBand', row_data.value->>'riskBand',
            'featuredRank', row_data.value->'featuredRank',
            'recentMutualRank', row_data.value->'recentMutualRank',
            'verificationShortlistRank', row_data.value->'verificationShortlistRank',
            'partnerSafetySource', row_data.value->>'partnerSafetySource',
            'partnerSafetyOperationKey', row_data.value->'partnerSafetyOperationKey',
            'partnerSafetyResultHash', row_data.value->'partnerSafetyResultHash'
        ) ORDER BY row_data.value->>'candidateId'
    ), '[]'::JSONB)
    INTO v_rows
    FROM pg_catalog.jsonb_array_elements(p_rows) AS row_data(value);
    v_row_count := pg_catalog.jsonb_array_length(v_rows);

    SELECT stage_manifest.shortlist_count
    INTO v_expected_shortlist
    FROM public.analysis_v2_dag_stage_manifests AS stage_manifest
    WHERE stage_manifest.request_id = p_request_id
      AND stage_manifest.stage_kind = 'screening';
    IF v_expected_shortlist IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF (
        SELECT pg_catalog.count(DISTINCT row_data.value->>'candidateId') <> v_row_count
        FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value)
    ) OR v_row_count <> (
        SELECT pg_catalog.count(*)
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value)
              WHERE row_data.value->>'candidateId' = feature.candidate_id
          )
    ) OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value)
        WHERE row_data.value->'verificationShortlistRank' <> 'null'::JSONB
    ) <> v_expected_shortlist OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value)
        WHERE (
                row_data.value->'featuredRank' <> 'null'::JSONB
                AND (
                    row_data.value->>'featuredRank' !~ '^(?:[1-9]|1[0-5])$'
                    OR (
                        row_data.value->>'riskBand' = 'high_risk'
                        AND (row_data.value->>'featuredRank')::INTEGER > 3
                    )
                )
              )
           OR (
                row_data.value->'recentMutualRank' <> 'null'::JSONB
                AND row_data.value->>'recentMutualRank' !~ '^(?:[1-9]|10)$'
              )
           OR (
                row_data.value->'verificationShortlistRank' <> 'null'::JSONB
                AND row_data.value->>'verificationShortlistRank' !~ '^(?:[1-9]|10)$'
              )
           OR (
                row_data.value->>'partnerSafetySource' = 'gemini'
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                    WHERE ai_result.request_id = p_request_id
                      AND ai_result.job_key = 'track:partner-safety:batch:0'
                      AND ai_result.operation_key = row_data.value->>'partnerSafetyOperationKey'
                      AND ai_result.stage = 'partnerSafety'
                      AND ai_result.result_hash = row_data.value->>'partnerSafetyResultHash'
                )
              )
           OR (
                row_data.value->>'partnerSafetySource' = 'safe_fallback'
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_ai_attempts AS ai_attempt
                    WHERE ai_attempt.request_id = p_request_id
                      AND ai_attempt.job_key = 'track:partner-safety:batch:0'
                      AND ai_attempt.operation_key = row_data.value->>'partnerSafetyOperationKey'
                      AND ai_attempt.stage = 'partnerSafety'
                      AND ai_attempt.status = 'rejected'
                )
              )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_result_hash := public.analysis_v2_result_staging_hash(
        'candidate_scores', NULL, v_rows
    );
    SELECT manifest.*
    INTO v_existing
    FROM public.analysis_v2_candidate_score_manifests AS manifest
    WHERE manifest.request_id = p_request_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.risk_policy_version <> p_risk_policy_version
           OR v_existing.item_count <> v_row_count
           OR v_existing.result_hash <> v_result_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_row_count, v_row_count, v_result_hash
        );
    END IF;

    INSERT INTO public.analysis_v2_candidate_score_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        risk_policy_version, item_count, result_hash
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_claim_token,
        p_risk_policy_version, v_row_count, v_result_hash
    );
    INSERT INTO public.analysis_v2_candidate_score_rows (
        request_id, candidate_id, display_score, risk_band, featured_rank,
        recent_mutual_rank, verification_shortlist_rank, partner_safety_source,
        partner_safety_operation_key, partner_safety_result_hash
    )
    SELECT
        p_request_id,
        row_data.value->>'candidateId',
        (row_data.value->>'displayScore')::NUMERIC,
        row_data.value->>'riskBand',
        CASE WHEN row_data.value->'featuredRank' = 'null'::JSONB
            THEN NULL ELSE (row_data.value->>'featuredRank')::SMALLINT END,
        CASE WHEN row_data.value->'recentMutualRank' = 'null'::JSONB
            THEN NULL ELSE (row_data.value->>'recentMutualRank')::SMALLINT END,
        CASE WHEN row_data.value->'verificationShortlistRank' = 'null'::JSONB
            THEN NULL ELSE (row_data.value->>'verificationShortlistRank')::SMALLINT END,
        row_data.value->>'partnerSafetySource',
        CASE WHEN row_data.value->'partnerSafetyOperationKey' = 'null'::JSONB
            THEN NULL ELSE row_data.value->>'partnerSafetyOperationKey' END,
        CASE WHEN row_data.value->'partnerSafetyResultHash' = 'null'::JSONB
            THEN NULL ELSE row_data.value->>'partnerSafetyResultHash' END
    FROM pg_catalog.jsonb_array_elements(v_rows) AS row_data(value);

    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_row_count, v_row_count, v_result_hash
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_private_names(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_batch INTEGER,
    p_source TEXT,
    p_operation_key TEXT,
    p_ai_result_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_hash TEXT;
    v_expected_count INTEGER;
    v_existing public.analysis_v2_private_name_manifests%ROWTYPE;
BEGIN
    IF p_batch IS NULL OR p_batch NOT BETWEEN 0 AND 100000
       OR p_source NOT IN ('checkpoint', 'safe_fallback')
       OR p_operation_key !~ '^private-account-name:[a-f0-9]{64}$'
       OR (p_source = 'checkpoint' AND (
            p_ai_result_hash IS NULL OR p_ai_result_hash !~ '^[a-f0-9]{64}$'
       ))
       OR (p_source = 'safe_fallback' AND p_ai_result_hash IS NOT NULL)
       OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100
       OR pg_catalog.octet_length(p_rows::TEXT) > 1048576
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImageUrl',
                    'nameFemaleScore', 'nameIsName', 'nameConfidence'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImageUrl',
                    'nameFemaleScore', 'nameIsName', 'nameConfidence'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
               OR item.value->>'candidateId' <> public.analysis_v2_result_candidate_id(
                    item.value->>'instagramId'
               )
               OR pg_catalog.jsonb_typeof(item.value->'fullName') NOT IN ('string', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'profileImageUrl') NOT IN ('string', 'null')
               OR NOT public.analysis_v2_result_valid_image_path(
                    NULLIF(item.value->>'profileImageUrl', '')
               )
               OR pg_catalog.jsonb_typeof(item.value->'nameFemaleScore') <> 'number'
               OR (item.value->>'nameFemaleScore')::NUMERIC NOT BETWEEN 0 AND 1
               OR pg_catalog.jsonb_typeof(item.value->'nameIsName') <> 'boolean'
               OR pg_catalog.jsonb_typeof(item.value->'nameConfidence') <> 'number'
               OR (item.value->>'nameConfidence')::NUMERIC NOT BETWEEN 0 AND 1
               OR (
                    NOT (item.value->>'nameIsName')::BOOLEAN
                    AND (item.value->>'nameFemaleScore')::NUMERIC <> 0.5
               )
               OR (
                    p_source = 'safe_fallback'
                    AND (
                        (item.value->>'nameFemaleScore')::NUMERIC <> 0.5
                        OR (item.value->>'nameIsName')::BOOLEAN
                        OR (item.value->>'nameConfidence')::NUMERIC <> 0
                    )
               )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:private-names:batch:' || p_batch::TEXT
       OR v_job.track <> 'private_names' OR v_job.kind <> 'ai'
       OR v_job.batch IS DISTINCT FROM p_batch THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT topology.item_count INTO v_expected_count
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id
      AND topology.topology_kind = 'private_name' AND topology.batch = p_batch
      AND topology.input_hash = p_job_input_hash;
    IF v_expected_count IS NULL OR v_expected_count <> pg_catalog.jsonb_array_length(p_rows)
       OR (
            p_source = 'checkpoint'
            AND NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                WHERE ai_result.request_id = p_request_id
                  AND ai_result.job_key = p_job_key
                  AND ai_result.operation_key = p_operation_key
                  AND ai_result.stage = 'privateAccountName'
                  AND ai_result.result_hash = p_ai_result_hash
            )
       ) OR (
            p_source = 'safe_fallback'
            AND NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
                WHERE ai_attempt.request_id = p_request_id
                  AND ai_attempt.job_key = p_job_key
                  AND ai_attempt.operation_key = p_operation_key
                  AND ai_attempt.stage = 'privateAccountName'
                  AND ai_attempt.status = 'rejected'
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'),
        '[]'::JSONB
    ) INTO v_rows FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    IF (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId')
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
    ) <> v_count OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE NOT EXISTS (
            SELECT 1
            FROM (
                SELECT mutual.username,
                    pg_catalog.row_number() OVER (ORDER BY mutual.mutual_ordinal) AS private_rank
                FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND mutual.job_key = 'track:relationships:collect'
                  AND mutual.is_private
            ) AS private_mutual
            WHERE (private_mutual.private_rank - 1) / 100 = p_batch
              AND private_mutual.username = item.value->>'instagramId'
        )
    ) OR v_count <> (
        SELECT pg_catalog.count(*)
        FROM (
            SELECT pg_catalog.row_number() OVER (ORDER BY mutual.mutual_ordinal) AS private_rank
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND mutual.job_key = 'track:relationships:collect'
              AND mutual.is_private
        ) AS private_mutual
        WHERE (private_mutual.private_rank - 1) / 100 = p_batch
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_hash := public.analysis_v2_result_staging_hash('private_names', p_batch, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_private_name_manifests AS manifest
    WHERE manifest.request_id = p_request_id AND manifest.batch = p_batch FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> v_count OR v_existing.source <> p_source
           OR v_existing.operation_key <> p_operation_key
           OR v_existing.ai_result_hash IS DISTINCT FROM p_ai_result_hash
           OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, p_batch, v_count, v_count, v_hash
        );
    END IF;

    INSERT INTO public.analysis_v2_private_name_manifests (
        request_id, batch, producer_job_key, producer_input_hash, producer_claim_token,
        item_count, source, operation_key, ai_result_hash, result_hash
    ) VALUES (
        p_request_id, p_batch, p_job_key, p_job_input_hash, p_claim_token,
        v_count, p_source, p_operation_key, p_ai_result_hash, v_hash
    );
    INSERT INTO public.analysis_v2_private_name_rows (
        request_id, batch, candidate_id, instagram_id, full_name, profile_image_url,
        name_female_score, name_is_name, name_confidence
    )
    SELECT p_request_id, p_batch, item.value->>'candidateId', item.value->>'instagramId',
        NULLIF(item.value->>'fullName', ''), NULLIF(item.value->>'profileImageUrl', ''),
        (item.value->>'nameFemaleScore')::NUMERIC,
        (item.value->>'nameIsName')::BOOLEAN,
        (item.value->>'nameConfidence')::NUMERIC
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);
    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, p_batch, v_count, v_count, v_hash
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_narratives(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_hash TEXT;
    v_existing public.analysis_v2_narrative_manifests%ROWTYPE;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 3
       OR pg_catalog.octet_length(p_rows::TEXT) > 65536
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'lines', 'source', 'operationKey', 'aiResultHash'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'lines', 'source', 'operationKey', 'aiResultHash'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR pg_catalog.jsonb_typeof(item.value->'lines') <> 'array'
               OR pg_catalog.jsonb_array_length(item.value->'lines') <> 2
               OR NOT public.analysis_v2_result_valid_public_copy(item.value->'lines'->>0, 180)
               OR NOT public.analysis_v2_result_valid_public_copy(item.value->'lines'->>1, 180)
               OR item.value->>'source' NOT IN ('checkpoint', 'safe_fallback')
               OR item.value->>'operationKey' !~ '^high-risk-narrative:[a-f0-9]{64}$'
               OR (
                    item.value->>'source' = 'checkpoint'
                    AND (
                        item.value->'aiResultHash' = 'null'::JSONB
                        OR item.value->>'aiResultHash' !~ '^[a-f0-9]{64}$'
                    )
               )
               OR (
                    item.value->>'source' = 'safe_fallback'
                    AND item.value->'aiResultHash' <> 'null'::JSONB
               )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:narratives:batch:0'
       OR v_job.track <> 'narratives' OR v_job.kind <> 'ai' OR v_job.batch <> 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(
        pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'),
        '[]'::JSONB
    ) INTO v_rows FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    IF v_count <> (
        SELECT pg_catalog.count(*)
        FROM public.analysis_v2_candidate_score_rows AS score
        WHERE score.request_id = p_request_id
          AND score.risk_band = 'high_risk' AND score.featured_rank BETWEEN 1 AND 3
    ) OR (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId')
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
    ) <> v_count OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_candidate_score_rows AS score
                WHERE score.request_id = p_request_id
                  AND score.candidate_id = item.value->>'candidateId'
                  AND score.risk_band = 'high_risk' AND score.featured_rank BETWEEN 1 AND 3
              )
           OR (
                item.value->>'source' = 'checkpoint'
                AND NOT EXISTS (
                    SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                    WHERE ai_result.request_id = p_request_id
                      AND ai_result.job_key = p_job_key
                      AND ai_result.operation_key = item.value->>'operationKey'
                      AND ai_result.stage = 'highRiskNarrative'
                      AND ai_result.result_hash = item.value->>'aiResultHash'
                )
              )
           OR (
                item.value->>'source' = 'safe_fallback'
                AND NOT EXISTS (
                    SELECT 1 FROM public.analysis_v2_ai_attempts AS ai_attempt
                    WHERE ai_attempt.request_id = p_request_id
                      AND ai_attempt.job_key = p_job_key
                      AND ai_attempt.operation_key = item.value->>'operationKey'
                      AND ai_attempt.stage = 'highRiskNarrative'
                      AND ai_attempt.status = 'rejected'
                )
              )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_hash := public.analysis_v2_result_staging_hash('narratives_v2', NULL, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_narrative_manifests AS manifest
    WHERE manifest.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> v_count OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_count, v_count, v_hash
        );
    END IF;
    INSERT INTO public.analysis_v2_narrative_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        item_count, result_hash
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_claim_token, v_count, v_hash
    );
    INSERT INTO public.analysis_v2_narrative_rows (
        request_id, candidate_id, line_one, line_two, source, operation_key, ai_result_hash
    )
    SELECT p_request_id, item.value->>'candidateId', item.value->'lines'->>0,
        item.value->'lines'->>1, item.value->>'source', item.value->>'operationKey',
        NULLIF(item.value->>'aiResultHash', '')
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);
    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_count, v_count, v_hash
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_result_stage_snapshot(p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.pipeline_version = 'v2'
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_candidate_feature_manifests AS manifest
        WHERE manifest.request_id = p_request_id
    ) THEN
        RETURN NULL;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'profileClassifications', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', feature.candidate_id,
                'instagramId', feature.instagram_id,
                'fullName', feature.full_name,
                'profileImageUrl', feature.profile_image_url,
                'bio', feature.bio,
                'classification', feature.terminal_classification,
                'mediaContext', feature.media_context,
                'genderOperationKey', feature.gender_operation_key,
                'genderResultHash', feature.gender_result_hash,
                'featureOperationKey', feature.feature_operation_key,
                'featureResultHash', feature.feature_result_hash,
                'feature', CASE WHEN feature.terminal_classification = 'verified_female'
                    THEN pg_catalog.jsonb_build_object(
                        'appearanceGrade', feature.appearance_grade,
                        'exposureScore', feature.exposure_score,
                        'isBusinessAccount', feature.is_business_account,
                        'featurePartnerEvidenceStrong',
                            feature.feature_partner_evidence_strong,
                        'oneLineOverview', feature.one_line_overview
                    ) ELSE NULL END
            ) ORDER BY feature.candidate_id)
            FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
        ), '[]'::JSONB),
        'preliminaryScores', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', score.candidate_id,
                'components', score.components,
                'preScore', score.pre_score,
                'possibleUpperBound', score.possible_upper_bound,
                'recentMutualRank', score.recent_mutual_rank,
                'verificationShortlistRank', score.verification_shortlist_rank
            ) ORDER BY score.candidate_id)
            FROM public.analysis_v2_preliminary_score_rows AS score
            WHERE score.request_id = p_request_id
        ), '[]'::JSONB),
        'reverseLikes', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', reverse_like.candidate_id,
                'status', reverse_like.reverse_like_status,
                'componentScore', reverse_like.component_score,
                'evidenceRefIds', pg_catalog.to_jsonb(reverse_like.evidence_ref_ids)
            ) ORDER BY reverse_like.candidate_id)
            FROM public.analysis_v2_reverse_like_rows AS reverse_like
            WHERE reverse_like.request_id = p_request_id
        ), '[]'::JSONB),
        'partnerSafety', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', partner.candidate_id,
                'source', partner.source,
                'hasStrongPartnerEvidence', partner.has_strong_partner_evidence,
                'hasWeakPartnerEvidence', partner.has_weak_partner_evidence,
                'strongEvidenceBasis', partner.strong_evidence_basis,
                'evidenceSelectionIds', pg_catalog.to_jsonb(partner.evidence_selection_ids),
                'bundleId', partner.bundle_id,
                'operationKey', partner.operation_key,
                'aiResultHash', partner.ai_result_hash
            ) ORDER BY partner.candidate_id)
            FROM public.analysis_v2_partner_safety_rows AS partner
            WHERE partner.request_id = p_request_id
        ), '[]'::JSONB),
        'finalScores', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', score.candidate_id,
                'displayScore', score.display_score,
                'riskBand', score.risk_band,
                'featuredRank', score.featured_rank,
                'recentMutualRank', score.recent_mutual_rank,
                'verificationShortlistRank', score.verification_shortlist_rank,
                'partnerSafetySource', score.partner_safety_source,
                'partnerSafetyOperationKey', score.partner_safety_operation_key,
                'partnerSafetyResultHash', score.partner_safety_result_hash,
                'components', score.components,
                'weakPartnerAdjustment', score.weak_partner_adjustment,
                'preScore', score.pre_score,
                'rawScore', score.raw_score,
                'possibleUpperBound', score.possible_upper_bound,
                'publicScore', score.public_score,
                'possibleUpperPublicScore', score.possible_upper_public_score,
                'partnerCapApplied', score.partner_cap_applied,
                'partnerEvidenceSelectionIds',
                    pg_catalog.to_jsonb(score.partner_evidence_selection_ids)
            ) ORDER BY score.candidate_id)
            FROM public.analysis_v2_candidate_score_rows AS score
            WHERE score.request_id = p_request_id
        ), '[]'::JSONB),
        'privateNames', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', private_name.candidate_id,
                'instagramId', private_name.instagram_id,
                'fullName', private_name.full_name,
                'profileImageUrl', private_name.profile_image_url,
                'nameFemaleScore', private_name.name_female_score,
                'nameIsName', private_name.name_is_name,
                'nameConfidence', private_name.name_confidence
            ) ORDER BY private_name.candidate_id)
            FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
        ), '[]'::JSONB),
        'narratives', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', narrative.candidate_id,
                'lines', pg_catalog.jsonb_build_array(
                    narrative.line_one, narrative.line_two
                ),
                'source', narrative.source,
                'operationKey', narrative.operation_key,
                'aiResultHash', narrative.ai_result_hash
            ) ORDER BY narrative.candidate_id)
            FROM public.analysis_v2_narrative_rows AS narrative
            WHERE narrative.request_id = p_request_id
        ), '[]'::JSONB)
    );
END;
$$;

-- Delete PII-bearing working sets only after their terminal consumer has persisted. Provider/AI
-- attempt ledgers, DAG manifests, job state, progress events, and media cleanup coordinates remain
-- as PII-free telemetry. Media registry rows remain until generation-fenced GCS cleanup succeeds.
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(
    p_request_id UUID,
    p_keep_final BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL OR p_keep_final IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    DELETE FROM public.analysis_v2_narrative_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_partner_safety_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_reverse_like_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_preliminary_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_private_name_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_feature_manifests WHERE request_id = p_request_id;

    DELETE FROM public.analysis_v2_ai_result_checkpoints WHERE request_id = p_request_id;
    IF pg_catalog.to_regclass(
        'public.analysis_v2_ai_scoring_stage_checkpoints'
    ) IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints'
            || ' WHERE request_id = $1'
        USING p_request_id;
    END IF;
    DELETE FROM public.analysis_v2_profile_fetch_batches WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_target_evidence_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_sides WHERE request_id = p_request_id;

    IF NOT p_keep_final THEN
        DELETE FROM public.analysis_v2_result_summaries WHERE request_id = p_request_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_scrub_terminal_request_pii(
    p_request_id UUID,
    p_now TIMESTAMP WITH TIME ZONE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    UPDATE public.analysis_preflights AS preflight
    SET target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        pii_scrubbed_at = COALESCE(preflight.pii_scrubbed_at, p_now),
        updated_at = p_now
    WHERE preflight.consumed_request_id = p_request_id
      AND preflight.status = 'consumed';

    UPDATE public.analysis_requests AS analysis_request
    SET target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(analysis_request.id::TEXT, '-', ''), 1, 20),
        exclusion_decision_snapshot = 'skip',
        excluded_instagram_id = NULL
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2';
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_summary_json(
    p_summary public.analysis_v2_result_summaries
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'targetInstagramId', p_summary.target_instagram_id,
        'targetProfileImageUrl', p_summary.target_profile_image_url,
        'planId', p_summary.plan_id,
        'followers', pg_catalog.jsonb_build_object(
            'declared', p_summary.followers_declared,
            'collected', p_summary.followers_collected,
            'coverageRatio', CASE WHEN p_summary.followers_declared = 0 THEN 1
                ELSE p_summary.followers_collected::DOUBLE PRECISION
                    / p_summary.followers_declared::DOUBLE PRECISION END,
            'meetsCoverageGate', p_summary.followers_declared = 0
                OR p_summary.followers_collected * 100 >= p_summary.followers_declared * 99,
            'exactCountMatch', p_summary.followers_collected = p_summary.followers_declared
        ),
        'following', pg_catalog.jsonb_build_object(
            'declared', p_summary.following_declared,
            'collected', p_summary.following_collected,
            'coverageRatio', CASE WHEN p_summary.following_declared = 0 THEN 1
                ELSE p_summary.following_collected::DOUBLE PRECISION
                    / p_summary.following_declared::DOUBLE PRECISION END,
            'meetsCoverageGate', p_summary.following_declared = 0
                OR p_summary.following_collected * 100 >= p_summary.following_declared * 99,
            'exactCountMatch', p_summary.following_collected = p_summary.following_declared
        ),
        'detectedMutuals', p_summary.detected_mutuals,
        'publicMutuals', p_summary.public_mutuals,
        'privateMutuals', p_summary.private_mutuals,
        'screenedMutuals', p_summary.screened_mutuals,
        'successfullyScreenedMutuals', p_summary.screened_mutuals
            - p_summary.fetch_unavailable_count - p_summary.media_unavailable_count,
        'fetchUnavailableMutuals', p_summary.fetch_unavailable_count,
        'mediaUnavailableMutuals', p_summary.media_unavailable_count,
        'notScreenedMutuals', p_summary.not_screened_mutuals,
        'exclusionApplied', p_summary.exclusion_applied,
        'scorePolicyVersion', p_summary.score_policy_version
    );
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_result_snapshot(
    p_request_id UUID,
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_user_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.user_id = p_user_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status = 'completed'
    ) THEN
        RETURN NULL;
    END IF;
    SELECT summary.* INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'summary', public.analysis_v2_result_summary_json(v_summary),
        'femaleAccounts', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', female.candidate_id,
                'sortOrdinal', female.sort_ordinal,
                'row', pg_catalog.jsonb_build_object(
                    'instagramId', female.instagram_id,
                    'fullName', female.full_name,
                    'profileImageUrl', female.profile_image_url,
                    'bio', female.bio,
                    'displayScore', female.display_score,
                    'riskBand', female.risk_band,
                    'featuredRank', female.featured_rank,
                    'recentMutualRank', female.recent_mutual_rank,
                    'analysisDepth', female.analysis_depth,
                    'oneLineOverview', female.one_line_overview,
                    'highRiskNarrative', CASE
                        WHEN female.narrative_line_one IS NULL THEN NULL
                        ELSE pg_catalog.jsonb_build_array(
                            female.narrative_line_one, female.narrative_line_two
                        ) END
                )
            ) ORDER BY female.sort_ordinal)
            FROM public.analysis_v2_female_results AS female
            WHERE female.request_id = p_request_id
        ), '[]'::JSONB),
        'privateAccounts', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', private_result.candidate_id,
                'sortOrdinal', private_result.sort_ordinal,
                'row', pg_catalog.jsonb_build_object(
                    'instagramId', private_result.instagram_id,
                    'fullName', private_result.full_name,
                    'profileImageUrl', private_result.profile_image_url
                )
            ) ORDER BY private_result.sort_ordinal)
            FROM public.analysis_v2_private_results AS private_result
            WHERE private_result.request_id = p_request_id
        ), '[]'::JSONB)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT
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
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_relationship public.analysis_v2_relationship_manifests%ROWTYPE;
    v_followers public.analysis_v2_relationship_sides%ROWTYPE;
    v_following public.analysis_v2_relationship_sides%ROWTYPE;
    v_progress public.analysis_progress_state%ROWTYPE;
    v_tracks JSONB;
    v_revision BIGINT;
    v_sequence BIGINT;
    v_fingerprint TEXT;
    v_event_key TEXT;
    v_profile_count INTEGER;
    v_private_count INTEGER;
    v_verified_count INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS DISTINCT FROM 'coordinator:finalize'
       OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR NOT public.analysis_v2_result_valid_image_path(p_target_profile_image_url) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.to_regclass(
        'public.analysis_v2_ai_scoring_stage_checkpoints'
    ) IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_job.request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_request.status = 'completed' THEN
        SELECT summary.* INTO v_summary
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = p_request_id;
        IF v_job.status <> 'completed'
           OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
           OR v_job.completion_token IS DISTINCT FROM p_claim_token
           OR v_summary.request_id IS NULL
           OR v_summary.finalizer_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_summary.target_profile_image_url IS DISTINCT FROM p_target_profile_image_url THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'finalized', FALSE,
            'requestStatus', 'completed',
            'summary', public.analysis_v2_result_summary_json(v_summary)
        );
    END IF;
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.track <> 'coordinator' OR v_job.kind <> 'finalizer'
       OR v_job.batch IS NOT NULL OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.cardinality(v_job.required_job_keys) < 1
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS sibling
            WHERE sibling.request_id = p_request_id
              AND sibling.job_key <> p_job_key AND sibling.status <> 'completed'
       ) OR EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(v_job.required_job_keys) AS required_key(value)
            LEFT JOIN public.analysis_pipeline_jobs AS required_job
              ON required_job.request_id = p_request_id
             AND required_job.job_key = required_key.value
            WHERE required_job.request_id IS NULL OR required_job.status <> 'completed'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT relationship_manifest.* INTO v_relationship
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = 'track:relationships:collect';
    SELECT side.* INTO v_followers
    FROM public.analysis_v2_relationship_sides AS side
    WHERE side.request_id = p_request_id
      AND side.job_key = 'track:relationships:collect' AND side.side = 'followers';
    SELECT side.* INTO v_following
    FROM public.analysis_v2_relationship_sides AS side
    WHERE side.request_id = p_request_id
      AND side.job_key = 'track:relationships:collect' AND side.side = 'following';

    IF v_relationship.request_id IS NULL OR v_followers.request_id IS NULL
       OR v_following.request_id IS NULL
       OR v_preflight.target_followers_count IS DISTINCT FROM v_followers.declared_count
       OR v_preflight.target_following_count IS DISTINCT FROM v_following.declared_count
       OR v_followers.collected_count * 100 < v_followers.declared_count * 99
       OR v_following.collected_count * 100 < v_following.declared_count * 99
       OR v_relationship.followers_result_hash <> v_followers.result_hash
       OR v_relationship.following_result_hash <> v_following.result_hash
       OR v_relationship.excluded_username IS DISTINCT FROM v_request.excluded_instagram_id
       OR v_relationship.detailed_mutual_limit IS DISTINCT FROM
            (v_request.analysis_scope_snapshot->>'detailedMutualLimit')::INTEGER
       OR v_relationship.detailed_public_count <> LEAST(
            v_relationship.public_count, v_relationship.detailed_mutual_limit
       ) OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.policy_versions_snapshot->>'risk' <> 'risk-policy-v2.2'
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_dag_scopes AS scope
            WHERE scope.request_id = p_request_id
              AND scope.plan_id = v_request.selected_plan_id_snapshot
              AND scope.excluded_count = CASE
                    WHEN v_request.exclusion_decision_snapshot = 'exclude' THEN 1 ELSE 0 END
              AND scope.exclusion_decision_hash = v_relationship.exclusion_decision_hash
       ) OR (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = p_request_id
       ) <> 8
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = p_request_id AND stage.stage_kind = 'relationships'
              AND stage.result_hash = v_relationship.result_hash
              AND stage.detected_mutual_count = v_relationship.mutual_count
              AND stage.public_count = v_relationship.public_count
              AND stage.private_count = v_relationship.private_count
              AND stage.detailed_selected_public_count = v_relationship.detailed_public_count
       ) OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_target_evidence_manifests AS evidence
            JOIN public.analysis_v2_dag_stage_manifests AS stage
              ON stage.request_id = evidence.request_id
             AND stage.stage_kind = 'target_evidence'
             AND stage.result_hash = evidence.result_hash
             AND stage.interactor_count = evidence.interactor_count
            WHERE evidence.request_id = p_request_id
              AND evidence.job_key = 'track:target-evidence:collect'
              AND evidence.target_username = pg_catalog.lower(v_request.target_instagram_id)
              AND evidence.excluded_username IS NOT DISTINCT FROM v_request.excluded_instagram_id
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.sum(topology.item_count), 0)::INTEGER INTO v_profile_count
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id AND topology.topology_kind = 'profile';
    SELECT COALESCE(pg_catalog.sum(topology.item_count), 0)::INTEGER INTO v_private_count
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id AND topology.topology_kind = 'private_name';
    SELECT pg_catalog.count(*)::INTEGER INTO v_verified_count
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = p_request_id
      AND feature.terminal_classification = 'verified_female';

    IF v_profile_count <> v_relationship.detailed_public_count
       OR v_private_count <> v_relationship.private_count
       OR v_profile_count <> (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
       ) OR v_private_count <> (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
       ) OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_dag_batch_topology AS topology
            LEFT JOIN public.analysis_v2_dag_batch_results AS fetch_result
              ON fetch_result.request_id = topology.request_id
             AND fetch_result.result_kind = 'profile_fetch'
             AND fetch_result.batch = topology.batch
             AND fetch_result.item_count = topology.item_count
            LEFT JOIN public.analysis_v2_dag_batch_results AS ai_result
              ON ai_result.request_id = topology.request_id
             AND ai_result.result_kind = 'profile_ai'
             AND ai_result.batch = topology.batch
             AND ai_result.item_count = topology.item_count
            LEFT JOIN public.analysis_v2_candidate_feature_manifests AS feature_manifest
              ON feature_manifest.request_id = topology.request_id
             AND feature_manifest.batch = topology.batch
             AND feature_manifest.item_count = topology.item_count
             AND feature_manifest.row_count = topology.item_count
             AND feature_manifest.producer_input_hash = ai_result.producer_input_hash
            LEFT JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
              ON rich_stage.request_id = topology.request_id
             AND rich_stage.stage_kind = 'profile_ai_batch'
             AND rich_stage.batch_key = topology.batch
             AND rich_stage.producer_input_hash = ai_result.producer_input_hash
             AND rich_stage.result_hash = ai_result.result_hash
             AND rich_stage.item_count = topology.item_count
            WHERE topology.request_id = p_request_id
              AND topology.topology_kind = 'profile'
              AND (fetch_result.request_id IS NULL OR ai_result.request_id IS NULL
                OR feature_manifest.request_id IS NULL OR rich_stage.request_id IS NULL)
       ) OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_dag_batch_topology AS topology
            LEFT JOIN public.analysis_v2_dag_batch_results AS private_result
              ON private_result.request_id = topology.request_id
             AND private_result.result_kind = 'private_name'
             AND private_result.batch = topology.batch
             AND private_result.item_count = topology.item_count
            LEFT JOIN public.analysis_v2_private_name_manifests AS private_manifest
              ON private_manifest.request_id = topology.request_id
             AND private_manifest.batch = topology.batch
             AND private_manifest.item_count = topology.item_count
             AND private_manifest.producer_input_hash = private_result.producer_input_hash
             AND private_manifest.result_hash = private_result.result_hash
            WHERE topology.request_id = p_request_id
              AND topology.topology_kind = 'private_name'
              AND (private_result.request_id IS NULL OR private_manifest.request_id IS NULL)
       ) OR EXISTS (
            SELECT 1 FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
              AND (
                feature.candidate_id <> public.analysis_v2_result_candidate_id(feature.instagram_id)
                OR feature.instagram_id = pg_catalog.lower(v_request.target_instagram_id)
                OR feature.instagram_id = v_request.excluded_instagram_id
                OR NOT EXISTS (
                    SELECT 1 FROM public.analysis_v2_mutual_rows AS mutual
                    WHERE mutual.request_id = p_request_id
                      AND mutual.job_key = 'track:relationships:collect'
                      AND mutual.username = feature.instagram_id
                      AND NOT mutual.is_private AND mutual.detailed_ordinal IS NOT NULL
                )
                OR NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_profile_fetch_batches AS profile_batch
                    JOIN public.analysis_v2_profile_fetch_outcomes AS outcome
                      ON outcome.request_id = profile_batch.request_id
                     AND outcome.job_key = profile_batch.job_key
                     AND outcome.username = feature.instagram_id
                     AND outcome.attempt = CASE
                        WHEN feature.instagram_id = ANY(
                            profile_batch.frozen_unresolved_usernames
                        ) THEN 'fallback' ELSE 'primary' END
                    WHERE profile_batch.request_id = p_request_id
                      AND profile_batch.job_key = 'track:profiles:batch:'
                            || feature.batch::TEXT
                      AND (
                        (
                            feature.terminal_classification = 'unavailable'
                            AND outcome.status <> 'success'
                        )
                        OR (
                            feature.terminal_classification = 'media_unavailable'
                            AND outcome.status = 'success'
                        )
                        OR (
                            feature.terminal_classification NOT IN (
                                'unavailable', 'media_unavailable'
                            )
                            AND outcome.status = 'success'
                        )
                      )
                )
              )
       ) OR EXISTS (
            SELECT 1 FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
              AND (
                private_name.candidate_id <>
                    public.analysis_v2_result_candidate_id(private_name.instagram_id)
                OR private_name.instagram_id = pg_catalog.lower(v_request.target_instagram_id)
                OR private_name.instagram_id = v_request.excluded_instagram_id
                OR NOT EXISTS (
                    SELECT 1 FROM public.analysis_v2_mutual_rows AS mutual
                    WHERE mutual.request_id = p_request_id
                      AND mutual.job_key = 'track:relationships:collect'
                      AND mutual.username = private_name.instagram_id AND mutual.is_private
                )
              )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS primary_join
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS primary_rich
          ON primary_rich.request_id = primary_join.request_id
         AND primary_rich.stage_kind = 'primary_join' AND primary_rich.batch_key = -1
         AND primary_rich.producer_input_hash = primary_join.producer_input_hash
         AND primary_rich.result_hash = primary_join.result_hash
        JOIN public.analysis_v2_dag_stage_manifests AS screening
          ON screening.request_id = primary_join.request_id
         AND screening.stage_kind = 'screening'
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS screening_rich
          ON screening_rich.request_id = screening.request_id
         AND screening_rich.stage_kind = 'screening' AND screening_rich.batch_key = -1
         AND screening_rich.producer_input_hash = screening.producer_input_hash
         AND screening_rich.result_hash = screening.result_hash
        JOIN public.analysis_v2_preliminary_score_manifests AS preliminary
          ON preliminary.request_id = primary_join.request_id
         AND preliminary.producer_input_hash = screening.producer_input_hash
         AND preliminary.item_count = screening.verified_female_count
        WHERE primary_join.request_id = p_request_id
          AND primary_join.stage_kind = 'primary_join'
          AND primary_join.verified_female_count = v_verified_count
          AND screening.verified_female_count = v_verified_count
          AND screening.shortlist_count = (
                SELECT pg_catalog.count(*)
                FROM public.analysis_v2_preliminary_score_rows AS score
                WHERE score.request_id = p_request_id
                  AND score.verification_shortlist_rank IS NOT NULL
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
          ON rich_stage.request_id = stage.request_id
         AND rich_stage.stage_kind = 'reverse_likes' AND rich_stage.batch_key = -1
         AND rich_stage.producer_input_hash = stage.producer_input_hash
         AND rich_stage.result_hash = stage.result_hash
        JOIN public.analysis_v2_reverse_like_manifests AS manifest
          ON manifest.request_id = stage.request_id
         AND manifest.producer_input_hash = stage.producer_input_hash
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'reverse_likes'
          AND stage.shortlist_count = (
                SELECT pg_catalog.count(*)
                FROM public.analysis_v2_preliminary_score_rows AS preliminary
                WHERE preliminary.request_id = p_request_id
                  AND preliminary.verification_shortlist_rank IS NOT NULL
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
          ON rich_stage.request_id = stage.request_id
         AND rich_stage.stage_kind = 'partner_safety' AND rich_stage.batch_key = -1
         AND rich_stage.producer_input_hash = stage.producer_input_hash
         AND rich_stage.result_hash = stage.result_hash
        JOIN public.analysis_v2_partner_safety_manifests AS manifest
          ON manifest.request_id = stage.request_id
         AND manifest.producer_input_hash = stage.producer_input_hash
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'partner_safety'
          AND stage.shortlist_count = (
                SELECT pg_catalog.count(*)
                FROM public.analysis_v2_preliminary_score_rows AS preliminary
                WHERE preliminary.request_id = p_request_id
                  AND preliminary.verification_shortlist_rank IS NOT NULL
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS final_stage
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS final_rich
          ON final_rich.request_id = final_stage.request_id
         AND final_rich.stage_kind = 'final_score' AND final_rich.batch_key = -1
         AND final_rich.producer_input_hash = final_stage.producer_input_hash
         AND final_rich.result_hash = final_stage.result_hash
        JOIN public.analysis_v2_candidate_score_manifests AS score_manifest
          ON score_manifest.request_id = final_stage.request_id
         AND score_manifest.producer_input_hash = final_stage.producer_input_hash
        JOIN public.analysis_v2_dag_stage_manifests AS narrative_stage
          ON narrative_stage.request_id = final_stage.request_id
         AND narrative_stage.stage_kind = 'narrative'
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS narrative_rich
          ON narrative_rich.request_id = narrative_stage.request_id
         AND narrative_rich.stage_kind = 'narrative' AND narrative_rich.batch_key = -1
         AND narrative_rich.producer_input_hash = narrative_stage.producer_input_hash
         AND narrative_rich.result_hash = narrative_stage.result_hash
        JOIN public.analysis_v2_narrative_manifests AS narrative_manifest
          ON narrative_manifest.request_id = final_stage.request_id
         AND narrative_manifest.producer_input_hash = narrative_stage.producer_input_hash
        WHERE final_stage.request_id = p_request_id
          AND final_stage.stage_kind = 'final_score'
          AND score_manifest.item_count = v_verified_count
          AND final_stage.featured_high_risk_count = narrative_manifest.item_count
          AND final_stage.narrative_count = narrative_manifest.item_count
          AND narrative_stage.narrative_count = narrative_manifest.item_count
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT progress_state.* INTO v_progress
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id FOR UPDATE;
    IF v_progress.request_id IS NULL
       OR v_progress.status NOT IN ('queued', 'processing')
       OR EXISTS (
            SELECT 1 FROM public.analysis_progress_events AS progress_event
            WHERE progress_event.request_id = p_request_id
              AND progress_event.event_code = 'ANALYSIS_COMPLETED'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_result_summaries (
        request_id, target_instagram_id, target_profile_image_url, plan_id,
        followers_declared, followers_collected, following_declared, following_collected,
        detected_mutuals, public_mutuals, private_mutuals, screened_mutuals,
        not_screened_mutuals, fetch_unavailable_count, media_unavailable_count,
        exclusion_applied, score_policy_version,
        finalizer_input_hash
    ) VALUES (
        p_request_id, pg_catalog.lower(v_request.target_instagram_id),
        p_target_profile_image_url, v_request.selected_plan_id_snapshot,
        v_followers.declared_count, v_followers.collected_count,
        v_following.declared_count, v_following.collected_count,
        v_relationship.mutual_count, v_relationship.public_count,
        v_relationship.private_count, v_relationship.detailed_public_count,
        v_relationship.public_count - v_relationship.detailed_public_count,
        (SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
              AND feature.terminal_classification = 'unavailable'),
        (SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
              AND feature.terminal_classification = 'media_unavailable'),
        v_request.exclusion_decision_snapshot = 'exclude', 'risk-policy-v2.2',
        p_job_input_hash
    ) RETURNING * INTO v_summary;

    INSERT INTO public.analysis_v2_female_results (
        request_id, candidate_id, sort_ordinal, instagram_id, full_name,
        profile_image_url, bio, display_score, risk_band, featured_rank,
        recent_mutual_rank, analysis_depth, one_line_overview,
        narrative_line_one, narrative_line_two
    )
    SELECT p_request_id, ordered.candidate_id, ordered.sort_ordinal,
        ordered.instagram_id, ordered.full_name, ordered.profile_image_url, ordered.bio,
        ordered.display_score, ordered.risk_band, ordered.featured_rank,
        ordered.recent_mutual_rank,
        CASE WHEN ordered.line_one IS NULL THEN 'features' ELSE 'narrative' END,
        ordered.one_line_overview, ordered.line_one, ordered.line_two
    FROM (
        SELECT feature.candidate_id, feature.instagram_id, feature.full_name,
            feature.profile_image_url, feature.bio, score.display_score, score.risk_band,
            score.featured_rank, score.recent_mutual_rank, feature.one_line_overview,
            narrative.line_one, narrative.line_two,
            pg_catalog.row_number() OVER (
                ORDER BY score.display_score DESC, feature.candidate_id
            )::SMALLINT AS sort_ordinal
        FROM public.analysis_v2_candidate_feature_rows AS feature
        JOIN public.analysis_v2_candidate_score_rows AS score
          ON score.request_id = feature.request_id
         AND score.candidate_id = feature.candidate_id
        LEFT JOIN public.analysis_v2_narrative_rows AS narrative
          ON narrative.request_id = feature.request_id
         AND narrative.candidate_id = feature.candidate_id
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'verified_female'
    ) AS ordered;

    INSERT INTO public.analysis_v2_private_results (
        request_id, candidate_id, sort_ordinal, instagram_id, full_name, profile_image_url
    )
    SELECT p_request_id, private_name.candidate_id,
        pg_catalog.row_number() OVER (
            ORDER BY private_name.name_female_score DESC,
                private_name.name_confidence DESC, private_name.instagram_id
        )::SMALLINT,
        private_name.instagram_id, private_name.full_name, private_name.profile_image_url
    FROM public.analysis_v2_private_name_rows AS private_name
    WHERE private_name.request_id = p_request_id;

    IF (SELECT pg_catalog.count(*) FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id) <> v_verified_count
       OR (SELECT pg_catalog.count(*) FROM public.analysis_v2_private_results AS private_result
        WHERE private_result.request_id = p_request_id) <> v_relationship.private_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_tracks := pg_catalog.jsonb_build_object(
        'relationshipAi', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'relationshipAi'->>'stageCode',
            'done', (v_progress.tracks->'relationshipAi'->>'total')::INTEGER,
            'total', (v_progress.tracks->'relationshipAi'->>'total')::INTEGER,
            'progressBp', CASE WHEN (v_progress.tracks->'relationshipAi'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        ),
        'interactions', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'interactions'->>'stageCode',
            'done', (v_progress.tracks->'interactions'->>'total')::INTEGER,
            'total', (v_progress.tracks->'interactions'->>'total')::INTEGER,
            'progressBp', CASE WHEN (v_progress.tracks->'interactions'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        ),
        'finalization', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'finalization'->>'stageCode',
            'done', (v_progress.tracks->'finalization'->>'total')::INTEGER,
            'total', (v_progress.tracks->'finalization'->>'total')::INTEGER,
            'progressBp', CASE WHEN (v_progress.tracks->'finalization'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        )
    );
    v_revision := v_progress.revision + 1;
    v_sequence := v_progress.last_event_seq + 1;
    v_fingerprint := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-progress-snapshot-v1',
        'requestId', p_request_id, 'status', 'completed', 'progressBp', 10000,
        'backgroundProcessing', FALSE, 'tracks', v_tracks,
        'activeProfile', NULL, 'etaRange', NULL
    ));
    v_event_key := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-progress-event-v1',
        'requestId', p_request_id, 'eventCode', 'ANALYSIS_COMPLETED'
    ));
    UPDATE public.analysis_progress_state AS progress_state
    SET revision = v_revision, status = 'completed', progress_bp = 10000,
        background_processing = FALSE, tracks = v_tracks, active_profile = NULL,
        eta_range = NULL, last_event_seq = v_sequence,
        snapshot_fingerprint = v_fingerprint, updated_at = v_now
    WHERE progress_state.request_id = p_request_id;
    INSERT INTO public.analysis_progress_events (
        request_id, seq, event_key, revision, snapshot_fingerprint, occurred_at,
        event_state, event_code, copy_code, aggregate_count
    ) VALUES (
        p_request_id, v_sequence, v_event_key, v_revision, v_fingerprint, v_now,
        'confirmed', 'ANALYSIS_COMPLETED', 'ANALYSIS_COMPLETED', NULL
    );

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        completion_token = p_claim_token, completion_fanout_hash = pg_catalog.md5('[]'),
        completed_at = v_now, updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key;
    UPDATE public.analysis_requests AS analysis_request
    SET status = 'completed', progress = 100, background_processing = FALSE,
        progress_step = 'V2 analysis completed', current_step = 'completed',
        error_message = NULL, completed_at = v_now
    WHERE analysis_request.id = p_request_id;

    PERFORM public.analysis_v2_scrub_terminal_request_pii(p_request_id, v_now);
    PERFORM public.analysis_v2_purge_result_working_set(p_request_id, TRUE);
    RETURN pg_catalog.jsonb_build_object(
        'finalized', TRUE,
        'requestStatus', 'completed',
        'summary', public.analysis_v2_result_summary_json(v_summary)
    );
END;
$$;

CREATE TABLE public.analysis_v2_failure_receipts (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    failed_job_key VARCHAR(160) NOT NULL,
    failed_job_input_hash VARCHAR(64) NOT NULL CHECK (
        failed_job_input_hash ~ '^[a-f0-9]{64}$'
    ),
    failed_claim_token UUID NOT NULL,
    error_code VARCHAR(64) NOT NULL CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, failed_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);
ALTER TABLE public.analysis_v2_failure_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_failure_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_failure_receipts
    FROM PUBLIC, anon, authenticated, service_role;

-- All fatal worker exits converge here. The helper remains lock-free: callers already hold the
-- canonical preflight -> request -> job order. It emits no finding/completion event.
CREATE OR REPLACE FUNCTION public.fail_analysis_v2_request_from_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_progress public.analysis_progress_state%ROWTYPE;
    v_tracks JSONB;
    v_fingerprint TEXT;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FAILURE_INPUT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
        last_error_code = p_error_code, last_error_at = v_now,
        completed_at = v_now, updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
      AND job.status IN ('pending', 'processing');
    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
        last_error_code = COALESCE(job.last_error_code, 'REQUEST_TERMINATED'),
        last_error_at = COALESCE(job.last_error_at, v_now),
        completed_at = v_now, updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key <> p_job_key
      AND job.status IN ('pending', 'processing');

    SELECT progress_state.* INTO v_progress
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id FOR UPDATE;
    IF v_progress.request_id IS NOT NULL
       AND v_progress.status IN ('queued', 'processing') THEN
        v_tracks := pg_catalog.jsonb_build_object(
            'relationshipAi', pg_catalog.jsonb_set(
                v_progress.tracks->'relationshipAi', ARRAY['state'],
                pg_catalog.to_jsonb(CASE
                    WHEN v_progress.tracks->'relationshipAi'->>'state' = 'completed'
                        THEN 'completed' ELSE 'failed' END::TEXT)
            ),
            'interactions', pg_catalog.jsonb_set(
                v_progress.tracks->'interactions', ARRAY['state'],
                pg_catalog.to_jsonb(CASE
                    WHEN v_progress.tracks->'interactions'->>'state' = 'completed'
                        THEN 'completed' ELSE 'failed' END::TEXT)
            ),
            'finalization', pg_catalog.jsonb_set(
                v_progress.tracks->'finalization', ARRAY['state'],
                pg_catalog.to_jsonb(CASE
                    WHEN v_progress.tracks->'finalization'->>'state' = 'completed'
                        THEN 'completed' ELSE 'failed' END::TEXT)
            )
        );
        v_fingerprint := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
            'domain', 'analysis-v2-progress-snapshot-v1',
            'requestId', p_request_id, 'status', 'failed',
            'progressBp', v_progress.progress_bp, 'backgroundProcessing', FALSE,
            'tracks', v_tracks, 'activeProfile', NULL, 'etaRange', NULL,
            'errorCode', p_error_code
        ));
        UPDATE public.analysis_progress_state AS progress_state
        SET revision = progress_state.revision + 1,
            status = 'failed', background_processing = FALSE,
            tracks = v_tracks, active_profile = NULL, eta_range = NULL,
            snapshot_fingerprint = v_fingerprint, updated_at = v_now
        WHERE progress_state.request_id = p_request_id;
    END IF;

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'failed', background_processing = FALSE,
        progress_step = 'V2 analysis failed', current_step = 'failed',
        error_message = p_error_code,
        completed_at = COALESCE(analysis_request.completed_at, v_now)
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status IN ('pending', 'processing');

    PERFORM public.analysis_v2_purge_result_working_set(p_request_id, FALSE);
    PERFORM public.analysis_v2_scrub_terminal_request_pii(p_request_id, v_now);
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_error_code TEXT
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
    v_receipt public.analysis_v2_failure_receipts%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT receipt.* INTO v_receipt
    FROM public.analysis_v2_failure_receipts AS receipt
    WHERE receipt.request_id = p_request_id FOR UPDATE;

    IF v_request.id IS NULL OR v_job.request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_request.status = 'failed' THEN
        IF v_receipt.request_id IS NULL
           OR v_receipt.failed_job_key IS DISTINCT FROM p_job_key
           OR v_receipt.failed_job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_receipt.failed_claim_token IS DISTINCT FROM p_claim_token
           OR v_receipt.error_code IS DISTINCT FROM p_error_code THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'finalized', FALSE, 'requestStatus', 'failed'
        );
    END IF;
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    INSERT INTO public.analysis_v2_failure_receipts (
        request_id, failed_job_key, failed_job_input_hash, failed_claim_token, error_code
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_claim_token, p_error_code
    );
    PERFORM public.fail_analysis_v2_request_from_job(
        p_request_id, p_job_key, p_error_code
    );
    RETURN pg_catalog.jsonb_build_object(
        'finalized', TRUE, 'requestStatus', 'failed'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_features(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_batch INTEGER,
    p_analyzed_count INTEGER,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_checkpoint_candidate_features_complete(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash,
        p_batch, p_analyzed_count, p_rows
    );
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_reverse_likes(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_hash TEXT;
    v_existing public.analysis_v2_reverse_like_manifests%ROWTYPE;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 900
       OR pg_catalog.octet_length(p_rows::TEXT) > 1048576
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'status', 'componentScore', 'evidenceRefIds'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'status', 'componentScore', 'evidenceRefIds'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'status' NOT IN ('observed', 'not_observed', 'not_collected')
               OR item.value->>'componentScore' NOT IN ('0', '3')
               OR pg_catalog.jsonb_typeof(item.value->'evidenceRefIds') <> 'array'
               OR pg_catalog.jsonb_array_length(item.value->'evidenceRefIds') > 8
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:reverse-likes:collect'
       OR v_job.track <> 'reverse_likes' OR v_job.kind <> 'collection' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'), '[]')
    INTO v_rows FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    IF v_count <> (
        SELECT pg_catalog.count(*) FROM public.analysis_v2_preliminary_score_rows AS score
        WHERE score.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1 FROM public.analysis_v2_preliminary_score_rows AS score
        WHERE score.request_id = p_request_id
          AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
              WHERE item.value->>'candidateId' = score.candidate_id
          )
    ) OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        JOIN public.analysis_v2_preliminary_score_rows AS preliminary
          ON preliminary.request_id = p_request_id
         AND preliminary.candidate_id = item.value->>'candidateId'
        WHERE (
                preliminary.verification_shortlist_rank IS NULL
                AND (
                    item.value->>'status' <> 'not_collected'
                    OR item.value->>'componentScore' <> '0'
                    OR pg_catalog.jsonb_array_length(item.value->'evidenceRefIds') <> 0
                )
              )
           OR (
                item.value->>'status' = 'observed'
                AND (
                    item.value->>'componentScore' <> '3'
                    OR pg_catalog.jsonb_array_length(item.value->'evidenceRefIds') = 0
                )
              )
           OR (
                item.value->>'status' <> 'observed'
                AND (
                    item.value->>'componentScore' <> '0'
                    OR pg_catalog.jsonb_array_length(item.value->'evidenceRefIds') <> 0
                )
              )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    v_hash := public.analysis_v2_result_staging_hash('reverse_likes', NULL, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_reverse_like_manifests AS manifest
    WHERE manifest.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> v_count OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_count, v_count, v_hash
        );
    END IF;
    INSERT INTO public.analysis_v2_reverse_like_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        item_count, result_hash
    ) VALUES (p_request_id, p_job_key, p_job_input_hash, p_claim_token, v_count, v_hash);
    INSERT INTO public.analysis_v2_reverse_like_rows (
        request_id, candidate_id, reverse_like_status, component_score, evidence_ref_ids
    )
    SELECT p_request_id, item.value->>'candidateId', item.value->>'status',
        (item.value->>'componentScore')::NUMERIC,
        ARRAY(
            SELECT evidence.value
            FROM pg_catalog.jsonb_array_elements_text(item.value->'evidenceRefIds')
                WITH ORDINALITY AS evidence(value, ordinality)
            ORDER BY evidence.ordinality
        )
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);
    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_count, v_count, v_hash
    );
END;
$$;

-- Rebuild every public partner-safety field from durable AI envelopes. A matching operation/hash
-- proves only result identity; it does not authorize callers to flip weak/strong flags or attach
-- unrelated evidence. Canonical evidence keeps the first occurrence from feature evidence first,
-- then contact-sheet evidence, and caps the ordered de-duplicated list at eight IDs.
CREATE OR REPLACE FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    p_request_id UUID,
    p_partner_job_key TEXT,
    p_value JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_feature public.analysis_v2_candidate_feature_rows%ROWTYPE;
    v_feature_ai public.analysis_v2_ai_result_checkpoints%ROWTYPE;
    v_partner_ai public.analysis_v2_ai_result_checkpoints%ROWTYPE;
    v_features JSONB;
    v_assessment JSONB;
    v_feature_evidence TEXT[] := '{}'::TEXT[];
    v_contact_evidence TEXT[] := '{}'::TEXT[];
    v_expected_evidence TEXT[] := '{}'::TEXT[];
    v_row_evidence TEXT[] := '{}'::TEXT[];
    v_feature_strong BOOLEAN;
    v_feature_weak BOOLEAN;
    v_contact_strong BOOLEAN := FALSE;
    v_contact_weak BOOLEAN := FALSE;
    v_expected_strong BOOLEAN;
    v_expected_weak_raw BOOLEAN;
    v_expected_weak BOOLEAN;
    v_expected_basis TEXT;
    v_source TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_partner_job_key IS NULL
       OR p_value IS NULL
       OR pg_catalog.jsonb_typeof(p_value) <> 'object'
       OR p_value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR p_value->>'source' NOT IN (
            'not_collected', 'feature_only', 'gemini', 'safe_fallback'
       )
       OR pg_catalog.jsonb_typeof(p_value->'hasStrongPartnerEvidence') <> 'boolean'
       OR pg_catalog.jsonb_typeof(p_value->'hasWeakPartnerEvidence') <> 'boolean'
       OR p_value->>'strongEvidenceBasis' NOT IN (
            'none', 'feature', 'contact_sheet', 'both'
       )
       OR pg_catalog.jsonb_typeof(p_value->'evidenceSelectionIds') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'evidenceSelectionIds') > 8 THEN
        RETURN FALSE;
    END IF;

    SELECT feature.*
    INTO v_feature
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = p_request_id
      AND feature.candidate_id = p_value->>'candidateId'
      AND feature.terminal_classification = 'verified_female';
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    SELECT ai_result.*
    INTO v_feature_ai
    FROM public.analysis_v2_ai_result_checkpoints AS ai_result
    JOIN public.analysis_v2_candidate_feature_manifests AS manifest
      ON manifest.request_id = v_feature.request_id
     AND manifest.batch = v_feature.batch
     AND manifest.producer_job_key = ai_result.job_key
    WHERE ai_result.request_id = p_request_id
      AND ai_result.operation_key = v_feature.feature_operation_key
      AND ai_result.stage = 'featureAnalysis'
      AND ai_result.result_hash = v_feature.feature_result_hash;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_features := v_feature_ai.result_json->'features';
    IF pg_catalog.jsonb_typeof(v_feature_ai.result_json) <> 'object'
       OR v_feature_ai.result_json->>'finalGenderDecision' <> 'verified_female'
       OR pg_catalog.jsonb_typeof(v_features) <> 'object'
       OR v_features->>'partnerExclusionContext' NOT IN (
            'none', 'celebrity_or_public_figure', 'older_relative', 'group_or_unclear'
       )
       OR v_features->>'marriageEvidence' NOT IN (
            'none', 'possible', 'strong', 'uncertain'
       )
       OR v_features->>'partnerEvidence' NOT IN (
            'none', 'weak', 'strong', 'uncertain'
       )
       OR pg_catalog.jsonb_typeof(v_features->'evidenceSelectionIds') <> 'object'
       OR pg_catalog.jsonb_typeof(
            v_features->'evidenceSelectionIds'->'marriagePartner'
          ) <> 'array'
       OR pg_catalog.jsonb_array_length(
            v_features->'evidenceSelectionIds'->'marriagePartner'
          ) > 10
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(
                v_features->'evidenceSelectionIds'->'marriagePartner'
            ) AS evidence(value)
            WHERE pg_catalog.jsonb_typeof(evidence.value) <> 'string'
               OR evidence.value #>> '{}' !~ '^[^[:cntrl:]]{1,240}$'
               OR NOT EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_array_elements_text(
                        v_feature.media_context->'selectionIds'
                    ) AS selected(value)
                    WHERE selected.value = evidence.value #>> '{}'
               )
       ) THEN
        RETURN FALSE;
    END IF;

    v_feature_strong := v_features->>'partnerExclusionContext' = 'none'
        AND (
            v_features->>'marriageEvidence' = 'strong'
            OR v_features->>'partnerEvidence' = 'strong'
        );
    v_feature_weak := v_features->>'partnerExclusionContext' = 'none'
        AND (
            v_features->>'marriageEvidence' = 'possible'
            OR v_features->>'partnerEvidence' = 'weak'
        );
    IF v_feature_strong OR v_feature_weak THEN
        SELECT COALESCE(
            pg_catalog.array_agg(evidence.value ORDER BY evidence.ordinality),
            '{}'::TEXT[]
        )
        INTO v_feature_evidence
        FROM pg_catalog.jsonb_array_elements_text(
            v_features->'evidenceSelectionIds'->'marriagePartner'
        ) WITH ORDINALITY AS evidence(value, ordinality);
    END IF;

    v_source := p_value->>'source';
    IF v_source = 'gemini' THEN
        SELECT ai_result.*
        INTO v_partner_ai
        FROM public.analysis_v2_ai_result_checkpoints AS ai_result
        WHERE ai_result.request_id = p_request_id
          AND ai_result.job_key = p_partner_job_key
          AND ai_result.operation_key = p_value->>'operationKey'
          AND ai_result.stage = 'partnerSafety'
          AND ai_result.result_hash = p_value->>'aiResultHash';
        IF NOT FOUND THEN
            RETURN FALSE;
        END IF;

        v_assessment := v_partner_ai.result_json->'assessment';
        IF pg_catalog.jsonb_typeof(v_partner_ai.result_json) <> 'object'
           OR v_partner_ai.result_json->>'source' <> 'gemini'
           OR pg_catalog.jsonb_typeof(
                v_partner_ai.result_json->'hasWeakNonExcludedMalePairEvidence'
              ) <> 'boolean'
           OR pg_catalog.jsonb_typeof(
                v_partner_ai.result_json->'hasStrongPartnerEvidence'
              ) <> 'boolean'
           OR v_partner_ai.result_json->>'strongEvidenceBasis' NOT IN (
                'none', 'feature', 'contact_sheet', 'both'
           )
           OR v_partner_ai.result_json->>'weakAdjustmentStatus' NOT IN (
                'not_applicable', 'applied_policy_v2_2'
           )
           OR v_partner_ai.result_json->>'analyzedContactSheetSelectionId'
                !~ '^contact-sheet:[a-f0-9]{64}$'
           OR pg_catalog.jsonb_typeof(v_assessment) <> 'object'
           OR v_assessment->>'partnerEvidence' NOT IN (
                'none', 'weak', 'strong', 'uncertain'
           )
           OR v_assessment->>'exclusionContext' NOT IN (
                'none', 'celebrity_or_public_figure', 'older_relative', 'group_or_unclear'
           )
           OR pg_catalog.jsonb_typeof(
                v_assessment->'evidenceSourceSelectionIds'
              ) <> 'array'
           OR pg_catalog.jsonb_array_length(
                v_assessment->'evidenceSourceSelectionIds'
              ) > 8
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements(
                    v_assessment->'evidenceSourceSelectionIds'
                ) AS evidence(value)
                WHERE pg_catalog.jsonb_typeof(evidence.value) <> 'string'
                   OR evidence.value #>> '{}' !~ '^[^[:cntrl:]]{1,240}$'
                   OR NOT EXISTS (
                        SELECT 1
                        FROM pg_catalog.jsonb_array_elements_text(
                            v_feature.media_context->'selectionIds'
                        ) AS selected(value)
                        WHERE selected.value = evidence.value #>> '{}'
                   )
           ) THEN
            RETURN FALSE;
        END IF;

        v_contact_strong := v_assessment->>'exclusionContext' = 'none'
            AND v_assessment->>'partnerEvidence' = 'strong';
        v_contact_weak := v_assessment->>'exclusionContext' = 'none'
            AND v_assessment->>'partnerEvidence' = 'weak';
        IF v_contact_strong OR v_contact_weak THEN
            SELECT COALESCE(
                pg_catalog.array_agg(evidence.value ORDER BY evidence.ordinality),
                '{}'::TEXT[]
            )
            INTO v_contact_evidence
            FROM pg_catalog.jsonb_array_elements_text(
                v_assessment->'evidenceSourceSelectionIds'
            ) WITH ORDINALITY AS evidence(value, ordinality);
        END IF;
    ELSIF v_source = 'safe_fallback' THEN
        IF p_value->>'bundleId' IS DISTINCT FROM v_feature.media_context->>'bundleId'
           OR p_value->>'operationKey' !~ '^partner-safety:[a-f0-9]{64}$'
           OR p_value->'aiResultHash' <> 'null'::JSONB
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_attempts AS ai_attempt
                WHERE ai_attempt.request_id = p_request_id
                  AND ai_attempt.job_key = p_partner_job_key
                  AND ai_attempt.operation_key = p_value->>'operationKey'
                  AND ai_attempt.stage = 'partnerSafety'
                  AND ai_attempt.status = 'rejected'
           ) THEN
            RETURN FALSE;
        END IF;
    ELSIF p_value->'bundleId' <> 'null'::JSONB
       OR p_value->'operationKey' <> 'null'::JSONB
       OR p_value->'aiResultHash' <> 'null'::JSONB THEN
        RETURN FALSE;
    END IF;

    v_expected_strong := v_feature_strong OR v_contact_strong;
    v_expected_weak_raw := v_feature_weak OR v_contact_weak;
    v_expected_weak := v_expected_weak_raw AND NOT v_expected_strong;
    v_expected_basis := CASE
        WHEN v_feature_strong AND v_contact_strong THEN 'both'
        WHEN v_feature_strong THEN 'feature'
        WHEN v_contact_strong THEN 'contact_sheet'
        ELSE 'none'
    END;

    IF v_source = 'gemini' AND (
        (v_partner_ai.result_json->>'hasStrongPartnerEvidence')::BOOLEAN
            IS DISTINCT FROM v_expected_strong
        OR (v_partner_ai.result_json->>'hasWeakNonExcludedMalePairEvidence')::BOOLEAN
            IS DISTINCT FROM v_expected_weak_raw
        OR v_partner_ai.result_json->>'strongEvidenceBasis'
            IS DISTINCT FROM v_expected_basis
        OR v_partner_ai.result_json->>'weakAdjustmentStatus' IS DISTINCT FROM CASE
            WHEN v_expected_weak THEN 'applied_policy_v2_2'
            ELSE 'not_applicable'
          END
        OR p_value->>'bundleId' IS DISTINCT FROM v_feature.media_context->>'bundleId'
    ) THEN
        RETURN FALSE;
    END IF;

    SELECT COALESCE(
        pg_catalog.array_agg(canonical.value ORDER BY canonical.first_ordinal),
        '{}'::TEXT[]
    )
    INTO v_expected_evidence
    FROM (
        SELECT combined.value, MIN(combined.ordinality) AS first_ordinal
        FROM (
            SELECT evidence.value, evidence.ordinality::BIGINT AS ordinality
            FROM pg_catalog.unnest(v_feature_evidence)
                WITH ORDINALITY AS evidence(value, ordinality)
            UNION ALL
            SELECT evidence.value, 1000 + evidence.ordinality::BIGINT AS ordinality
            FROM pg_catalog.unnest(v_contact_evidence)
                WITH ORDINALITY AS evidence(value, ordinality)
        ) AS combined
        GROUP BY combined.value
        ORDER BY MIN(combined.ordinality)
        LIMIT 8
    ) AS canonical;
    SELECT COALESCE(
        pg_catalog.array_agg(evidence.value ORDER BY evidence.ordinality),
        '{}'::TEXT[]
    )
    INTO v_row_evidence
    FROM pg_catalog.jsonb_array_elements_text(p_value->'evidenceSelectionIds')
        WITH ORDINALITY AS evidence(value, ordinality);

    RETURN (p_value->>'hasStrongPartnerEvidence')::BOOLEAN
            IS NOT DISTINCT FROM v_expected_strong
       AND (p_value->>'hasWeakPartnerEvidence')::BOOLEAN
            IS NOT DISTINCT FROM v_expected_weak
       AND p_value->>'strongEvidenceBasis' IS NOT DISTINCT FROM v_expected_basis
       AND v_row_evidence IS NOT DISTINCT FROM v_expected_evidence
       AND public.analysis_v2_result_valid_ref_list(v_row_evidence, 8);
EXCEPTION
    WHEN data_exception THEN
        RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_partner_safety(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_hash TEXT;
    v_existing public.analysis_v2_partner_safety_manifests%ROWTYPE;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 900
       OR pg_catalog.octet_length(p_rows::TEXT) > 2097152
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                'candidateId', 'source', 'hasStrongPartnerEvidence',
                'hasWeakPartnerEvidence',
                'strongEvidenceBasis', 'evidenceSelectionIds', 'bundleId',
                    'operationKey', 'aiResultHash'
               ])
               OR item.value - ARRAY[
                'candidateId', 'source', 'hasStrongPartnerEvidence',
                'hasWeakPartnerEvidence',
                'strongEvidenceBasis', 'evidenceSelectionIds', 'bundleId',
                    'operationKey', 'aiResultHash'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'source' NOT IN (
                    'not_collected', 'feature_only', 'gemini', 'safe_fallback'
               )
               OR pg_catalog.jsonb_typeof(item.value->'hasStrongPartnerEvidence') <> 'boolean'
               OR pg_catalog.jsonb_typeof(item.value->'hasWeakPartnerEvidence') <> 'boolean'
               OR item.value->>'strongEvidenceBasis' NOT IN (
                    'none', 'feature', 'contact_sheet', 'both'
               )
               OR pg_catalog.jsonb_typeof(item.value->'evidenceSelectionIds') <> 'array'
               OR pg_catalog.jsonb_array_length(item.value->'evidenceSelectionIds') > 8
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:partner-safety:batch:0'
       OR v_job.track <> 'partner_safety' OR v_job.kind <> 'ai' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'), '[]')
    INTO v_rows FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    IF v_count <> (
        SELECT pg_catalog.count(*) FROM public.analysis_v2_preliminary_score_rows AS score
        WHERE score.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1 FROM public.analysis_v2_preliminary_score_rows AS score
        WHERE score.request_id = p_request_id
          AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
              WHERE item.value->>'candidateId' = score.candidate_id
          )
    ) OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        JOIN public.analysis_v2_preliminary_score_rows AS preliminary
          ON preliminary.request_id = p_request_id
         AND preliminary.candidate_id = item.value->>'candidateId'
        WHERE (
                preliminary.verification_shortlist_rank IS NULL
                AND item.value->>'source' <> 'not_collected'
              )
           OR (
                preliminary.verification_shortlist_rank IS NOT NULL
                AND item.value->>'source' = 'not_collected'
              )
           OR NOT public.analysis_v2_result_partner_safety_row_matches(
                p_request_id,
                p_job_key,
                item.value
              )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    v_hash := public.analysis_v2_result_staging_hash('partner_safety', NULL, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_partner_safety_manifests AS manifest
    WHERE manifest.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> v_count OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_count, v_count, v_hash
        );
    END IF;
    INSERT INTO public.analysis_v2_partner_safety_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        item_count, result_hash
    ) VALUES (p_request_id, p_job_key, p_job_input_hash, p_claim_token, v_count, v_hash);
    INSERT INTO public.analysis_v2_partner_safety_rows (
        request_id, candidate_id, source, has_strong_partner_evidence,
        has_weak_partner_evidence, strong_evidence_basis, evidence_selection_ids,
        bundle_id, operation_key, ai_result_hash
    )
    SELECT p_request_id, item.value->>'candidateId', item.value->>'source',
        (item.value->>'hasStrongPartnerEvidence')::BOOLEAN,
        (item.value->>'hasWeakPartnerEvidence')::BOOLEAN,
        item.value->>'strongEvidenceBasis',
        ARRAY(
            SELECT evidence.value
            FROM pg_catalog.jsonb_array_elements_text(item.value->'evidenceSelectionIds')
                WITH ORDINALITY AS evidence(value, ordinality)
            ORDER BY evidence.ordinality
        ),
        NULLIF(item.value->>'bundleId', ''),
        NULLIF(item.value->>'operationKey', ''),
        NULLIF(item.value->>'aiResultHash', '')
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);
    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_count, v_count, v_hash
    );
END;
$$;

-- Numeric JSON validation must fail closed instead of exposing casts to planner reordering.
CREATE OR REPLACE FUNCTION public.analysis_v2_result_valid_score_components(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
    RETURN p_value IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_value) = 'object'
       AND p_value ?& ARRAY[
            'candidateToTargetLikes', 'candidateToTargetComments',
            'targetToCandidateLike', 'tagOrCaptionMention',
            'recentMutual', 'appearanceExposure'
       ]
       AND p_value - ARRAY[
            'candidateToTargetLikes', 'candidateToTargetComments',
            'targetToCandidateLike', 'tagOrCaptionMention',
            'recentMutual', 'appearanceExposure'
       ] = '{}'::JSONB
       AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetLikes') = 'number'
       AND (p_value->>'candidateToTargetLikes')::NUMERIC BETWEEN 0 AND 20
       AND pg_catalog.jsonb_typeof(p_value->'candidateToTargetComments') = 'number'
       AND (p_value->>'candidateToTargetComments')::NUMERIC BETWEEN 0 AND 26
       AND pg_catalog.jsonb_typeof(p_value->'targetToCandidateLike') = 'number'
       AND (p_value->>'targetToCandidateLike')::NUMERIC BETWEEN 0 AND 3
       AND pg_catalog.jsonb_typeof(p_value->'tagOrCaptionMention') = 'number'
       AND (p_value->>'tagOrCaptionMention')::NUMERIC BETWEEN 0 AND 14
       AND pg_catalog.jsonb_typeof(p_value->'recentMutual') = 'number'
       AND (p_value->>'recentMutual')::NUMERIC BETWEEN 0 AND 17
       AND pg_catalog.jsonb_typeof(p_value->'appearanceExposure') = 'number'
       AND (p_value->>'appearanceExposure')::NUMERIC BETWEEN 0 AND 20;
EXCEPTION
    WHEN data_exception THEN
        RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_result_candidate_id(p_username TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT 'candidate:' || pg_catalog.substr(
        pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    'analysis-v2-candidate-id-v1' || pg_catalog.chr(10)
                        || pg_catalog.lower(p_username),
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
        ),
        1,
        40
    );
$$;

-- The final score is a private replay checkpoint. It is accepted only when every field is the
-- deterministic join of preliminary, reverse-like, and partner-safety staging.
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB,
    p_risk_policy_version TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rows JSONB;
    v_count INTEGER;
    v_hash TEXT;
    v_existing public.analysis_v2_candidate_score_manifests%ROWTYPE;
BEGIN
    IF p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.2'
       OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 900
       OR pg_catalog.octet_length(p_rows::TEXT) > 4194304
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                    'recentMutualRank', 'verificationShortlistRank',
                    'partnerSafetySource', 'partnerSafetyOperationKey',
                    'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                    'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                    'weakPartnerAdjustment', 'partnerCapApplied',
                    'partnerEvidenceSelectionIds'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'displayScore', 'riskBand', 'featuredRank',
                    'recentMutualRank', 'verificationShortlistRank',
                    'partnerSafetySource', 'partnerSafetyOperationKey',
                    'partnerSafetyResultHash', 'components', 'preScore', 'rawScore',
                    'possibleUpperBound', 'publicScore', 'possibleUpperPublicScore',
                    'weakPartnerAdjustment', 'partnerCapApplied',
                    'partnerEvidenceSelectionIds'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'riskBand' NOT IN ('normal', 'caution', 'high_risk')
               OR item.value->>'partnerSafetySource' NOT IN (
                    'not_collected', 'feature_only', 'gemini', 'safe_fallback'
               )
               OR NOT public.analysis_v2_result_valid_score_components(
                    item.value->'components'
               )
               OR pg_catalog.jsonb_typeof(item.value->'partnerCapApplied') <> 'boolean'
               OR pg_catalog.jsonb_typeof(item.value->'partnerEvidenceSelectionIds') <> 'array'
               OR pg_catalog.jsonb_array_length(item.value->'partnerEvidenceSelectionIds') > 8
               OR EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_each(item.value) AS field(key, field_value)
                    WHERE field.key IN (
                        'displayScore', 'preScore', 'rawScore', 'possibleUpperBound',
                        'publicScore', 'possibleUpperPublicScore',
                        'weakPartnerAdjustment'
                    )
                      AND pg_catalog.jsonb_typeof(field.field_value) <> 'number'
               )
               OR pg_catalog.jsonb_typeof(item.value->'featuredRank') NOT IN ('number', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'recentMutualRank') NOT IN ('number', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'verificationShortlistRank')
                    NOT IN ('number', 'null')
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE (item.value->>'weakPartnerAdjustment')::NUMERIC NOT IN (-5, 0)
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'coordinator:join:final-score'
       OR v_job.track <> 'coordinator' OR v_job.kind <> 'join'
       OR v_job.batch IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.policy_versions_snapshot->>'risk' = p_risk_policy_version
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId'),
        '[]'::JSONB
    ) INTO v_rows
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    v_count := pg_catalog.jsonb_array_length(v_rows);
    IF v_count <> (
        SELECT pg_catalog.count(*)
        FROM public.analysis_v2_preliminary_score_rows AS preliminary
        WHERE preliminary.request_id = p_request_id
    ) OR (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId')
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
    ) <> v_count OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        LEFT JOIN public.analysis_v2_preliminary_score_rows AS preliminary
          ON preliminary.request_id = p_request_id
         AND preliminary.candidate_id = item.value->>'candidateId'
        LEFT JOIN public.analysis_v2_reverse_like_rows AS reverse_like
          ON reverse_like.request_id = p_request_id
         AND reverse_like.candidate_id = item.value->>'candidateId'
        LEFT JOIN public.analysis_v2_partner_safety_rows AS partner
          ON partner.request_id = p_request_id
         AND partner.candidate_id = item.value->>'candidateId'
        CROSS JOIN LATERAL (
            SELECT
                (item.value->'components'->>'candidateToTargetLikes')::NUMERIC
                    + (item.value->'components'->>'candidateToTargetComments')::NUMERIC
                    + (item.value->'components'->>'targetToCandidateLike')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'appearanceExposure')::NUMERIC
                    AS component_total,
                (item.value->'components'->>'candidateToTargetLikes')::NUMERIC
                    + (item.value->'components'->>'candidateToTargetComments')::NUMERIC
                    + (item.value->'components'->>'tagOrCaptionMention')::NUMERIC
                    + (item.value->'components'->>'recentMutual')::NUMERIC
                    + (item.value->'components'->>'appearanceExposure')::NUMERIC
                    AS preliminary_component_total
        ) AS component_sum
        CROSS JOIN LATERAL (
            SELECT
                GREATEST(0, LEAST(
                    component_sum.preliminary_component_total
                        + (item.value->>'weakPartnerAdjustment')::NUMERIC,
                    97
                )) AS expected_pre_score,
                GREATEST(0, LEAST(
                    component_sum.component_total
                        + (item.value->>'weakPartnerAdjustment')::NUMERIC,
                    100
                )) AS expected_raw_score
        ) AS expected_score
        WHERE preliminary.candidate_id IS NULL
           OR reverse_like.candidate_id IS NULL
           OR partner.candidate_id IS NULL
           OR item.value->'components' IS DISTINCT FROM pg_catalog.jsonb_set(
                preliminary.components,
                ARRAY['targetToCandidateLike'],
                pg_catalog.to_jsonb(reverse_like.component_score),
                TRUE
           )
           OR (item.value->>'weakPartnerAdjustment')::NUMERIC IS DISTINCT FROM
                CASE WHEN partner.has_weak_partner_evidence
                          AND NOT partner.has_strong_partner_evidence
                    THEN -5::NUMERIC ELSE 0::NUMERIC END
           OR pg_catalog.abs(
                (item.value->>'preScore')::NUMERIC - expected_score.expected_pre_score
              ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'rawScore')::NUMERIC
                - expected_score.expected_raw_score
           ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'possibleUpperBound')::NUMERIC
                - CASE reverse_like.reverse_like_status
                    WHEN 'not_collected' THEN LEAST(
                        expected_score.expected_pre_score + 3,
                        100
                    )
                    ELSE expected_score.expected_raw_score
                  END
           ) > 0.0001
           OR item.value->'recentMutualRank' IS DISTINCT FROM
                COALESCE(pg_catalog.to_jsonb(preliminary.recent_mutual_rank), 'null'::JSONB)
           OR item.value->'verificationShortlistRank' IS DISTINCT FROM
                COALESCE(
                    pg_catalog.to_jsonb(preliminary.verification_shortlist_rank),
                    'null'::JSONB
                )
           OR item.value->>'partnerSafetySource' IS DISTINCT FROM partner.source
           OR item.value->'partnerSafetyOperationKey' IS DISTINCT FROM
                COALESCE(pg_catalog.to_jsonb(partner.operation_key), 'null'::JSONB)
           OR item.value->'partnerSafetyResultHash' IS DISTINCT FROM
                COALESCE(pg_catalog.to_jsonb(partner.ai_result_hash), 'null'::JSONB)
           OR ARRAY(
                SELECT selection_id.value
                FROM pg_catalog.jsonb_array_elements_text(
                    item.value->'partnerEvidenceSelectionIds'
                ) WITH ORDINALITY AS selection_id(value, ordinality)
                ORDER BY selection_id.ordinality
              ) IS DISTINCT FROM partner.evidence_selection_ids
           OR pg_catalog.abs(
                (item.value->>'publicScore')::NUMERIC
                - CASE WHEN partner.has_strong_partner_evidence
                    THEN LEAST(
                        1 + 9 * expected_score.expected_raw_score / 100,
                        3.4
                    )
                    ELSE 1 + 9 * expected_score.expected_raw_score / 100
                  END
           ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'displayScore')::NUMERIC
                - pg_catalog.round((item.value->>'publicScore')::NUMERIC, 1)
           ) > 0.0001
           OR pg_catalog.abs(
                (item.value->>'possibleUpperPublicScore')::NUMERIC
                - CASE WHEN partner.has_strong_partner_evidence
                    THEN LEAST(1 + 9 * (item.value->>'possibleUpperBound')::NUMERIC / 100, 3.4)
                    ELSE 1 + 9 * (item.value->>'possibleUpperBound')::NUMERIC / 100
                  END
           ) > 0.0001
           OR (item.value->>'partnerCapApplied')::BOOLEAN IS DISTINCT FROM (
                partner.has_strong_partner_evidence
                AND 1 + 9 * expected_score.expected_raw_score / 100 > 3.4
           )
           OR item.value->>'riskBand' IS DISTINCT FROM CASE
                WHEN (item.value->>'publicScore')::NUMERIC < 4.2 THEN 'normal'
                WHEN (item.value->>'publicScore')::NUMERIC < 6.8 THEN 'caution'
                ELSE 'high_risk'
              END
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_hash := public.analysis_v2_result_staging_hash('candidate_scores_v2', NULL, v_rows);
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_candidate_score_manifests AS manifest
    WHERE manifest.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.risk_policy_version <> p_risk_policy_version
           OR v_existing.item_count <> v_count OR v_existing.result_hash <> v_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, NULL, v_count, v_count, v_hash
        );
    END IF;

    INSERT INTO public.analysis_v2_candidate_score_manifests (
        request_id, producer_job_key, producer_input_hash, producer_claim_token,
        risk_policy_version, item_count, result_hash
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_claim_token,
        p_risk_policy_version, v_count, v_hash
    );
    INSERT INTO public.analysis_v2_candidate_score_rows (
        request_id, candidate_id, display_score, risk_band, featured_rank,
        recent_mutual_rank, verification_shortlist_rank, partner_safety_source,
        partner_safety_operation_key, partner_safety_result_hash, components,
        weak_partner_adjustment, pre_score, raw_score, possible_upper_bound, public_score,
        possible_upper_public_score, partner_cap_applied, partner_evidence_selection_ids
    )
    SELECT p_request_id, item.value->>'candidateId',
        (item.value->>'displayScore')::NUMERIC, item.value->>'riskBand',
        CASE WHEN item.value->'featuredRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'featuredRank')::SMALLINT END,
        CASE WHEN item.value->'recentMutualRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'recentMutualRank')::SMALLINT END,
        CASE WHEN item.value->'verificationShortlistRank' = 'null'::JSONB THEN NULL
            ELSE (item.value->>'verificationShortlistRank')::SMALLINT END,
        item.value->>'partnerSafetySource',
        NULLIF(item.value->>'partnerSafetyOperationKey', ''),
        NULLIF(item.value->>'partnerSafetyResultHash', ''), item.value->'components',
        (item.value->>'weakPartnerAdjustment')::NUMERIC,
        (item.value->>'preScore')::NUMERIC, (item.value->>'rawScore')::NUMERIC,
        (item.value->>'possibleUpperBound')::NUMERIC,
        (item.value->>'publicScore')::NUMERIC,
        (item.value->>'possibleUpperPublicScore')::NUMERIC,
        (item.value->>'partnerCapApplied')::BOOLEAN,
        ARRAY(
            SELECT selection_id.value
            FROM pg_catalog.jsonb_array_elements_text(
                item.value->'partnerEvidenceSelectionIds'
            ) WITH ORDINALITY AS selection_id(value, ordinality)
            ORDER BY selection_id.ordinality
        )
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);

    IF EXISTS (
        SELECT 1
        FROM (
            SELECT score.candidate_id, score.risk_band, score.featured_rank,
                pg_catalog.row_number() OVER (
                    PARTITION BY score.risk_band
                    ORDER BY score.display_score DESC, score.candidate_id
                ) AS expected_rank
            FROM public.analysis_v2_candidate_score_rows AS score
            WHERE score.request_id = p_request_id
              AND score.risk_band IN ('high_risk', 'caution')
        ) AS ranked
        WHERE ranked.featured_rank IS DISTINCT FROM CASE
            WHEN ranked.risk_band = 'high_risk' AND ranked.expected_rank <= 3
                THEN ranked.expected_rank::SMALLINT
            WHEN ranked.risk_band = 'caution' AND ranked.expected_rank <= 15
                THEN ranked.expected_rank::SMALLINT
            ELSE NULL
        END
    ) OR EXISTS (
        SELECT 1 FROM public.analysis_v2_candidate_score_rows AS score
        WHERE score.request_id = p_request_id
          AND score.risk_band = 'normal' AND score.featured_rank IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, NULL, v_count, v_count, v_hash
    );
END;
$$;

-- Result tables remain inaccessible even to service_role; bounded SECURITY DEFINER RPCs are the
-- only mutation/read surface. This prevents raw CDN URLs from crossing the client boundary.
REVOKE ALL ON FUNCTION public.analysis_v2_result_valid_image_path(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_valid_public_copy(TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_staging_hash(TEXT, INTEGER, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_valid_media_context(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_valid_score_components(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_valid_ref_list(TEXT[], INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_candidate_id(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_assert_result_job_fence(UUID, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_checkpoint_json(
    UUID, TEXT, INTEGER, INTEGER, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_purge_result_working_set(UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_scrub_terminal_request_pii(
    UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_result_summary_json(
    public.analysis_v2_result_summaries
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fail_analysis_v2_request_from_job(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_candidate_features(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_candidate_features(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_reverse_likes(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_reverse_likes(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_partner_safety(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_partner_safety(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_candidate_scores(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_private_names(
    UUID, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_private_names(
    UUID, TEXT, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_narratives(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_narratives(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_result_stage_snapshot(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_stage_snapshot(UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_result_snapshot(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_snapshot(UUID, UUID)
    TO service_role;

COMMENT ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Exact-lease finalizer: verifies durable DAG/evidence/AI staging, writes minimal owner results, completes progress with one event, and purges PII atomically.';
COMMENT ON FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Any exact live V2 job may terminally fail the request; all nonterminal jobs, progress, and PII working sets converge in the same transaction without a finding event.';
COMMENT ON FUNCTION public.load_analysis_v2_result_snapshot(UUID, UUID) IS
    'Service-only owner-checked raw result snapshot. Application code must mint fresh image proxy signatures before returning it.';

CREATE OR REPLACE FUNCTION public.load_analysis_v2_result_page(
    p_request_id UUID,
    p_user_id UUID,
    p_female_after_ordinal INTEGER,
    p_female_after_candidate_id TEXT,
    p_private_after_ordinal INTEGER,
    p_private_after_candidate_id TEXT,
    p_page_size INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_user_id IS NULL
       OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 50
       OR (p_female_after_ordinal IS NULL) <> (p_female_after_candidate_id IS NULL)
       OR (p_private_after_ordinal IS NULL) <> (p_private_after_candidate_id IS NULL)
       OR (
            p_female_after_ordinal IS NOT NULL
            AND (
                p_female_after_ordinal NOT BETWEEN 1 AND 900
                OR p_female_after_candidate_id !~ '^[A-Za-z0-9._:-]{1,128}$'
            )
       ) OR (
            p_private_after_ordinal IS NOT NULL
            AND (
                p_private_after_ordinal NOT BETWEEN 1 AND 1200
                OR p_private_after_candidate_id !~ '^[A-Za-z0-9._:-]{1,128}$'
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.user_id = p_user_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status = 'completed'
    ) THEN
        RETURN NULL;
    END IF;
    SELECT summary.* INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'summary', public.analysis_v2_result_summary_json(v_summary),
        'femaleAccounts', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', page.candidate_id,
                'sortOrdinal', page.sort_ordinal,
                'row', pg_catalog.jsonb_build_object(
                    'instagramId', page.instagram_id,
                    'fullName', page.full_name,
                    'profileImageUrl', page.profile_image_url,
                    'bio', page.bio,
                    'displayScore', page.display_score,
                    'riskBand', page.risk_band,
                    'featuredRank', page.featured_rank,
                    'recentMutualRank', page.recent_mutual_rank,
                    'analysisDepth', page.analysis_depth,
                    'oneLineOverview', page.one_line_overview,
                    'highRiskNarrative', CASE
                        WHEN page.narrative_line_one IS NULL THEN NULL
                        ELSE pg_catalog.jsonb_build_array(
                            page.narrative_line_one, page.narrative_line_two
                        ) END
                )
            ) ORDER BY page.sort_ordinal, page.candidate_id)
            FROM (
                SELECT female.*
                FROM public.analysis_v2_female_results AS female
                WHERE female.request_id = p_request_id
                  AND (
                    p_female_after_ordinal IS NULL
                    OR female.sort_ordinal > p_female_after_ordinal
                    OR (
                        female.sort_ordinal = p_female_after_ordinal
                        AND female.candidate_id > p_female_after_candidate_id
                    )
                  )
                ORDER BY female.sort_ordinal, female.candidate_id
                LIMIT p_page_size + 1
            ) AS page
        ), '[]'::JSONB),
        'privateAccounts', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'candidateId', page.candidate_id,
                'sortOrdinal', page.sort_ordinal,
                'row', pg_catalog.jsonb_build_object(
                    'instagramId', page.instagram_id,
                    'fullName', page.full_name,
                    'profileImageUrl', page.profile_image_url
                )
            ) ORDER BY page.sort_ordinal, page.candidate_id)
            FROM (
                SELECT private_result.*
                FROM public.analysis_v2_private_results AS private_result
                WHERE private_result.request_id = p_request_id
                  AND (
                    p_private_after_ordinal IS NULL
                    OR private_result.sort_ordinal > p_private_after_ordinal
                    OR (
                        private_result.sort_ordinal = p_private_after_ordinal
                        AND private_result.candidate_id > p_private_after_candidate_id
                    )
                  )
                ORDER BY private_result.sort_ordinal, private_result.candidate_id
                LIMIT p_page_size + 1
            ) AS page
        ), '[]'::JSONB)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_result_image_url(
    p_request_id UUID,
    p_kind TEXT,
    p_candidate_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_url TEXT;
BEGIN
    IF p_request_id IS NULL OR p_kind NOT IN ('target', 'female', 'private')
       OR (p_kind = 'target' AND p_candidate_id IS NOT NULL)
       OR (
            p_kind <> 'target'
            AND (p_candidate_id IS NULL OR p_candidate_id !~ '^[A-Za-z0-9._:-]{1,128}$')
       ) THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status = 'completed'
    ) THEN
        RETURN NULL;
    END IF;
    IF p_kind = 'target' THEN
        SELECT summary.target_profile_image_url INTO v_url
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = p_request_id;
    ELSIF p_kind = 'female' THEN
        SELECT female.profile_image_url INTO v_url
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
          AND female.candidate_id = p_candidate_id;
    ELSE
        SELECT private_result.profile_image_url INTO v_url
        FROM public.analysis_v2_private_results AS private_result
        WHERE private_result.request_id = p_request_id
          AND private_result.candidate_id = p_candidate_id;
    END IF;
    RETURN v_url;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_result_page(
    UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_page(
    UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, INTEGER
) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_result_image_url(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_image_url(UUID, TEXT, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_result_page(
    UUID, UUID, INTEGER, TEXT, INTEGER, TEXT, INTEGER
) IS 'Owner-checked bounded keyset page. Returns at most pageSize+1 rows per result list.';
COMMENT ON FUNCTION public.load_analysis_v2_result_image_url(UUID, TEXT, TEXT) IS
    'Resolves a raw result image only for the server after an opaque locator token is verified.';
