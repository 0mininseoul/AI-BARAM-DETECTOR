-- Groble이 order 64115d4d-ae82-48ed-9a0d-0480c100a6c2 (Standard, 100% 할인 쿠폰,
-- 실결제 0원)의 payment.completed 웹훅을 프로덕션에 전달하지 않아 주문이
-- payment_pending 에 멈춰 있었다. Groble 대시보드와 카카오 알림톡(판매/구매 알림)
-- 은 결제 완료를 확인해 주었으므로, 실제 웹훅이 왔을 때와 동일한 경로
-- (finalize_earlybird_groble_payment)로 이 주문 한 건만 수동 정산한다.
--
-- 구매자 이메일/전화번호는 이 파일에도, 아래 SELECT 출력에도 나타나지 않는다.
-- 주문 행 자신의 컬럼값을 서브쿼리로 함수 파라미터에 그대로 흘려보내고,
-- 반환 컬럼은 disposition/order_id/status/plan_sequence 뿐이다.
--
-- event_id/payment_id는 실제 Groble 값과 충돌하지 않는 수동 식별자라, 이후
-- Groble이 동일 주문에 대해 뒤늦게 진짜 웹훅을 보내도 안전하다 — 그때는 주문이
-- 이미 payment_pending 이 아니므로 매칭 후보에서 빠져 unmatched 로 남는다.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT f.*
FROM public.earlybird_orders AS o
CROSS JOIN LATERAL public.finalize_earlybird_groble_payment(
    p_event_id => 'evt_manual_recon_64115d4d_20260719',
    p_idempotency_key => 'idem_manual_recon_64115d4d_20260719',
    p_event_type => 'payment.completed',
    p_occurred_at => o.created_at,
    p_payment_id => 'manual_recon_64115d4d_v1',
    p_buyer_email => (SELECT u.email FROM public.users AS u WHERE u.id = o.user_id),
    p_buyer_phone_normalized => o.expected_buyer_phone_number_normalized,
    p_buyer_phone_raw => NULL,
    p_buyer_display_name => NULL,
    p_product_id => o.expected_groble_product_id,
    p_amount_krw => 0,
    p_paid_at => o.created_at
) AS f
WHERE o.id = '64115d4d-ae82-48ed-9a0d-0480c100a6c2';
