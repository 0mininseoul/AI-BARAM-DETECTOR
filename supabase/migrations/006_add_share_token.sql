-- 결과 공유 기능을 위한 토큰 컬럼 추가
-- share_token: 64자 hex 문자열, 공유 URL에 사용
-- share_enabled: 공유 활성화 여부

ALTER TABLE analysis_requests
ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE,
ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN DEFAULT FALSE;

-- 토큰 조회 성능을 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_analysis_requests_share_token
ON analysis_requests(share_token)
WHERE share_token IS NOT NULL;

-- 코멘트 추가
COMMENT ON COLUMN analysis_requests.share_token IS '공유 URL 토큰 (64자 hex)';
COMMENT ON COLUMN analysis_requests.share_enabled IS '공유 활성화 여부';
