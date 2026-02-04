-- AI 분석 결과 캐싱 테이블 (영구 저장, 만료 없음)
CREATE TABLE IF NOT EXISTS ai_analysis_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instagram_username TEXT NOT NULL UNIQUE,
    analysis_result JSONB NOT NULL,
    profile_pic_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 인덱스: username으로 빠른 조회
CREATE INDEX IF NOT EXISTS idx_ai_cache_username ON ai_analysis_cache(instagram_username);

-- Gemini API 토큰 사용량 추적 테이블
CREATE TABLE IF NOT EXISTS gemini_token_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID REFERENCES analysis_requests(id) ON DELETE SET NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    analysis_type TEXT NOT NULL, -- 'combined', 'gender', 'intimacy' 등
    model_name TEXT NOT NULL DEFAULT 'gemini-3-flash-preview',
    cached_hit BOOLEAN DEFAULT FALSE, -- 캐시 히트 여부
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 인덱스: 날짜별 토큰 사용량 집계
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON gemini_token_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_request ON gemini_token_usage(request_id);

-- 일별 토큰 사용량 집계 뷰
CREATE OR REPLACE VIEW daily_token_usage AS
SELECT
    DATE(created_at) as date,
    analysis_type,
    COUNT(*) as api_calls,
    SUM(CASE WHEN cached_hit THEN 1 ELSE 0 END) as cache_hits,
    SUM(prompt_tokens) as total_prompt_tokens,
    SUM(completion_tokens) as total_completion_tokens,
    SUM(total_tokens) as total_tokens
FROM gemini_token_usage
GROUP BY DATE(created_at), analysis_type
ORDER BY date DESC, analysis_type;

-- RLS 정책 (admin만 접근 가능)
ALTER TABLE ai_analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE gemini_token_usage ENABLE ROW LEVEL SECURITY;

-- Service role만 접근 허용
CREATE POLICY "Service role access only" ON ai_analysis_cache
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role access only" ON gemini_token_usage
    FOR ALL USING (auth.role() = 'service_role');
