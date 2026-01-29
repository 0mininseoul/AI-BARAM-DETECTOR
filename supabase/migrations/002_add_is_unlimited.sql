-- 002_add_is_unlimited.sql
-- users 테이블에 무제한 이용 가능 컬럼 추가

ALTER TABLE users
ADD COLUMN is_unlimited BOOLEAN DEFAULT FALSE;

-- 기존 is_paid_user가 true인 경우 is_unlimited도 true로 설정 (선택사항)
-- UPDATE users SET is_unlimited = true WHERE is_paid_user = true;

COMMENT ON COLUMN users.is_unlimited IS '무제한 분석 이용 가능 여부 (관리자가 설정)';
