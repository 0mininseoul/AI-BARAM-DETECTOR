-- 결제 대기 분석 테이블
CREATE TABLE IF NOT EXISTS pending_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_instagram_id TEXT NOT NULL,
    target_gender TEXT NOT NULL CHECK (target_gender IN ('male', 'female')),
    plan_type TEXT NOT NULL CHECK (plan_type IN ('basic', 'standard')),
    status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'paid', 'refunded', 'expired')),
    polar_checkout_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 결제 주문 기록 테이블
CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    polar_order_id TEXT UNIQUE NOT NULL,
    customer_email TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'completed',
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- analysis_requests 테이블에 plan_type, gender_stats 컬럼 추가
ALTER TABLE analysis_requests 
ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'basic' CHECK (plan_type IN ('basic', 'standard'));

ALTER TABLE analysis_requests 
ADD COLUMN IF NOT EXISTS gender_stats JSONB;

-- analysis_results 테이블에 새로운 컬럼들 추가
ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS bio TEXT;

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS photogenic_grade INTEGER;

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS exposure_level TEXT CHECK (exposure_level IN ('high', 'low'));

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS is_tagged BOOLEAN DEFAULT FALSE;

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS risk_grade TEXT CHECK (risk_grade IN ('high_risk', 'caution', 'normal'));

ALTER TABLE analysis_results
ADD COLUMN IF NOT EXISTS gender_status TEXT CHECK (gender_status IN ('confirmed', 'suspected', 'unknown'));

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_pending_analysis_user_id ON pending_analysis(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_analysis_status ON pending_analysis(status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_polar_order_id ON payment_orders(polar_order_id);

-- RLS 정책
ALTER TABLE pending_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;

-- pending_analysis RLS
CREATE POLICY "Users can view own pending analysis" ON pending_analysis
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own pending analysis" ON pending_analysis
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- payment_orders는 서버 측에서만 접근 (서비스 역할 사용)
