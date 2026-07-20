-- Widen the paid-provider operation-key validator to admit the 'profile-repair' kind.
--
-- Change scope: ONLY the regex alternation gains 'profile-repair'. Every modifier is reproduced
-- verbatim from 20260713171647 (LANGUAGE sql IMMUTABLE STRICT SET search_path = ''). STRICT is
-- kept deliberately: the operation_key column is NOT NULL so STRICT never fires in practice, but
-- dropping a modifier on the function that analysis_v2_provider_run_operation_key_check depends on
-- would be a needless behavioural delta.
--
-- This is a strict superset. 'profile-repair' is 14 chars, so its operation key is 14 + 1 + 64 =
-- 79 chars, inside the existing char_length BETWEEN 78 AND 87 bound and under the
-- analysis_v2_provider_runs.operation_key VARCHAR(87) column. Every string the prior regex
-- accepted, this one still accepts, so no stored analysis_v2_provider_runs row is invalidated.
-- The function is IMMUTABLE and backs the operation_key CHECK; PostgreSQL does not revalidate
-- existing rows when an IMMUTABLE function behind a CHECK is replaced, which is safe precisely
-- because the accepted set only grows. CREATE OR REPLACE preserves the prior REVOKEs, so the
-- function stays callable only through its SECURITY DEFINER RPC and CHECK callers.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_provider_operation_key(
    p_operation_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.char_length(p_operation_key) BETWEEN 78 AND 87
       AND p_operation_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$';
$$;
