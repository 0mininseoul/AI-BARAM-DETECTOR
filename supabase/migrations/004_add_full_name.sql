-- 004_add_full_name.sql
-- analysis_results와 private_accounts에 full_name 컬럼 추가

-- analysis_results 테이블에 full_name 추가
ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS suspect_full_name VARCHAR(255);

-- private_accounts 테이블에 full_name 추가
ALTER TABLE private_accounts
ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
