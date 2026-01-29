-- 003_add_step_data.sql
-- 단계별 분석을 위한 중간 데이터 저장 컬럼 추가

-- 현재 단계 식별자
ALTER TABLE analysis_requests
ADD COLUMN IF NOT EXISTS current_step VARCHAR(50) DEFAULT 'pending';

-- 단계별 중간 데이터 (JSONB)
ALTER TABLE analysis_requests
ADD COLUMN IF NOT EXISTS step_data JSONB DEFAULT '{}';

-- gender_stats가 없으면 추가 (기존 코드에서 사용 중)
ALTER TABLE analysis_requests
ADD COLUMN IF NOT EXISTS gender_stats JSONB DEFAULT '{}';

-- plan_type 컬럼 추가 (basic/standard)
ALTER TABLE analysis_requests
ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'basic';

-- analysis_results 테이블에 누락된 컬럼 추가
ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS bio TEXT;

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS photogenic_grade INTEGER DEFAULT 1;

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS exposure_level VARCHAR(10) DEFAULT 'low';

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS is_tagged BOOLEAN DEFAULT FALSE;

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS risk_grade VARCHAR(10) DEFAULT 'low';

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS gender_status VARCHAR(20) DEFAULT 'unknown';

-- 인덱스 추가
CREATE INDEX IF NOT EXISTS idx_analysis_requests_current_step
ON analysis_requests(current_step);
