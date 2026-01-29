import { Polar } from '@polar-sh/sdk';

// Polar 클라이언트 초기화
export const polar = new Polar({
    accessToken: process.env.POLAR_ACCESS_TOKEN!,
    server: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
});

// 구독 플랜 ID (Polar 대시보드에서 생성 후 설정)
export const PLAN_IDS = {
    BASIC: process.env.POLAR_BASIC_PRODUCT_ID!,
    STANDARD: process.env.POLAR_STANDARD_PRODUCT_ID!,
} as const;

// 가격 정보
export const PRICING = {
    BASIC: {
        amount: 299, // $2.99 in cents
        currency: 'usd',
        name: 'Basic',
        description: '팔로워/팔로잉 500명까지 분석',
        limit: 500,
    },
    STANDARD: {
        amount: 599, // $5.99 in cents
        currency: 'usd',
        name: 'Standard',
        description: '팔로워/팔로잉 1000명까지 분석',
        limit: 1000,
    },
} as const;

export type PlanType = 'basic' | 'standard';

/**
 * 체크아웃 세션 생성
 */
export async function createCheckoutSession({
    productId,
    successUrl,
    customerId,
    metadata,
}: {
    productId: string;
    successUrl: string;
    customerId?: string;
    metadata?: Record<string, string>;
}) {
    try {
        const checkout = await polar.checkouts.create({
            products: [productId],
            successUrl,
            customerEmail: customerId,
            metadata,
        });
        return checkout;
    } catch (error) {
        console.error('Checkout session creation failed:', error);
        throw error;
    }
}

/**
 * 주문 상태 확인
 */
export async function getOrder(orderId: string) {
    try {
        const order = await polar.orders.get({ id: orderId });
        return order;
    } catch (error) {
        console.error('Order fetch failed:', error);
        return null;
    }
}
