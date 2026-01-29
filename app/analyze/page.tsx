'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { trackEvent, EVENTS } from '@/lib/services/analytics';

type PlanType = 'basic' | 'standard';

interface PlanInfo {
    name: string;
    price: string;
    limit: number;
    description: string;
    productId: string;
    recommended?: boolean;
}

// Polar 제품 ID (환경 변수에서 가져옴)
const PLANS: Record<PlanType, PlanInfo> = {
    basic: {
        name: 'Basic',
        price: '$2.99',
        limit: 500,
        description: '팔로워/팔로잉 500명까지',
        productId: process.env.NEXT_PUBLIC_POLAR_BASIC_PRODUCT_ID || '',
    },
    standard: {
        name: 'Standard',
        price: '$5.99',
        limit: 1000,
        description: '팔로워/팔로잉 1000명까지',
        productId: process.env.NEXT_PUBLIC_POLAR_STANDARD_PRODUCT_ID || '',
        recommended: true,
    },
};

export default function AnalyzePage() {
    const [step, setStep] = useState<'input' | 'plan'>('input');
    const [instagramId, setInstagramId] = useState('');
    const [selectedPlan, setSelectedPlan] = useState<PlanType>('standard');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();
    const { user } = useAuth();

    const handleNext = () => {
        if (!instagramId.trim()) {
            setError('인스타그램 아이디를 입력해주세요.');
            return;
        }
        setError(null);
        setStep('plan');
        trackEvent(EVENTS.VIEW_PRICING);
    };

    const handleCheckout = async () => {
        if (!user) {
            router.push('/login');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // pending_analysis 생성
            const response = await fetch('/api/payment/pending', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planType: selectedPlan,
                    targetInstagramId: instagramId.replace('@', '').trim(),
                    targetGender: 'male',
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                setError(data.error || '요청 생성에 실패했습니다.');
                return;
            }

            trackEvent(EVENTS.CLICK_CHECKOUT, { plan: selectedPlan });

            // Polar 체크아웃으로 리다이렉트 (쿼리 파라미터 방식)
            const plan = PLANS[selectedPlan];
            const metadata = JSON.stringify({
                pending_analysis_id: data.pendingId,
                target_instagram_id: instagramId.replace('@', '').trim(),
                plan_type: selectedPlan,
            });

            const checkoutUrl = new URL('/api/payment/checkout', window.location.origin);
            checkoutUrl.searchParams.set('products', plan.productId);
            checkoutUrl.searchParams.set('customerEmail', user.email || '');
            checkoutUrl.searchParams.set('metadata', metadata);

            window.location.href = checkoutUrl.toString();
        } catch (err) {
            setError('서버 오류가 발생했습니다.');
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            {/* 헤더 */}
            <div className="mb-8 text-center">
                <div className="text-4xl mb-4">🔍</div>
                <h1 className="text-xl font-bold text-white">
                    {step === 'input' ? 'AI 위장 여사친 판독기' : '요금제 선택'}
                </h1>
            </div>

            {step === 'input' ? (
                /* Step 1: 정보 입력 */
                <div className="w-full max-w-sm space-y-6">
                    {/* 인스타그램 ID 입력 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            남자친구 인스타그램 아이디
                        </label>
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">@</span>
                            <input
                                type="text"
                                value={instagramId}
                                onChange={(e) => setInstagramId(e.target.value)}
                                placeholder="username"
                                className="w-full bg-gray-900 border border-gray-700 rounded-xl py-3.5 pl-9 pr-4 text-white placeholder-gray-500 focus:outline-none focus:border-pink-400 focus:ring-1 focus:ring-pink-400 transition-all"
                            />
                        </div>
                    </div>

                    {/* 공개 계정 안내 */}
                    <div className="flex items-start gap-2 p-3 bg-gray-900/50 rounded-xl border border-gray-800">
                        <span className="text-amber-400">⚠️</span>
                        <p className="text-xs text-gray-400">
                            공개 계정만 분석 가능합니다. 비공개 계정은 분석할 수 없어요.
                        </p>
                    </div>

                    {/* 에러 메시지 */}
                    {error && (
                        <div className="p-3 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 text-sm">
                            {error}
                        </div>
                    )}

                    {/* 다음 버튼 */}
                    <button
                        onClick={handleNext}
                        disabled={!instagramId.trim()}
                        className="w-full bg-gradient-to-r from-pink-500 to-purple-500 hover:from-pink-400 hover:to-purple-400 disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 text-white font-bold py-4 px-4 rounded-xl transition-all"
                    >
                        다음 단계로
                    </button>
                </div>
            ) : (
                /* Step 2: 요금제 선택 */
                <div className="w-full max-w-md space-y-6">
                    {/* 분석 대상 표시 */}
                    <div className="text-center text-gray-400 text-sm">
                        분석 대상: <span className="text-white font-medium">@{instagramId}</span>
                    </div>

                    {/* 요금제 카드 */}
                    <div className="space-y-4">
                        {(Object.keys(PLANS) as PlanType[]).map((planKey) => {
                            const plan = PLANS[planKey];
                            const isSelected = selectedPlan === planKey;
                            return (
                                <button
                                    key={planKey}
                                    onClick={() => setSelectedPlan(planKey)}
                                    className={`w-full p-4 rounded-xl border-2 text-left transition-all relative ${isSelected
                                            ? 'border-pink-500 bg-pink-500/10'
                                            : 'border-gray-700 bg-gray-900 hover:border-gray-500'
                                        }`}
                                >
                                    {plan.recommended && (
                                        <span className="absolute -top-2 right-4 bg-pink-500 text-xs text-white font-bold px-2 py-0.5 rounded">
                                            추천
                                        </span>
                                    )}
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="font-bold text-white text-lg">{plan.name}</div>
                                            <div className="text-gray-400 text-sm">{plan.description}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-2xl font-bold text-white">{plan.price}</div>
                                            <div className="text-gray-500 text-xs">1회 분석</div>
                                        </div>
                                    </div>
                                    <div className="mt-2 flex items-center gap-2">
                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-pink-500 bg-pink-500' : 'border-gray-500'
                                            }`}>
                                            {isSelected && (
                                                <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
                                                    <path d="M10.28 2.28L4.5 8.06 2.72 6.28a.75.75 0 00-1.06 1.06l2.5 2.5a.75.75 0 001.06 0l6.5-6.5a.75.75 0 00-1.06-1.06z" />
                                                </svg>
                                            )}
                                        </div>
                                        <span className="text-gray-400 text-sm">최대 {plan.limit}명 분석</span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* 에러 메시지 */}
                    {error && (
                        <div className="p-3 bg-red-900/30 border border-red-500/50 rounded-xl text-red-300 text-sm">
                            {error}
                        </div>
                    )}

                    {/* 버튼 그룹 */}
                    <div className="flex gap-3">
                        <button
                            onClick={() => setStep('input')}
                            className="flex-1 bg-gray-800 text-gray-300 font-medium py-4 px-4 rounded-xl hover:bg-gray-700 transition-all"
                        >
                            이전
                        </button>
                        <button
                            onClick={handleCheckout}
                            disabled={loading}
                            className="flex-2 bg-gradient-to-r from-pink-500 to-purple-500 hover:from-pink-400 hover:to-purple-400 disabled:from-gray-700 disabled:to-gray-700 text-white font-bold py-4 px-8 rounded-xl transition-all"
                        >
                            {loading ? '처리 중...' : `${PLANS[selectedPlan].price} 결제하기`}
                        </button>
                    </div>

                    {/* 안내 문구 */}
                    <div className="text-center space-y-2">
                        <p className="text-xs text-gray-500">
                            💳 안전한 Polar 결제를 통해 처리됩니다
                        </p>
                        <p className="text-xs text-gray-600">
                            결제 후 즉시 분석이 시작됩니다
                        </p>
                    </div>
                </div>
            )}

            {/* 면책 조항 */}
            <p className="mt-8 text-xs text-gray-500 text-center max-w-sm">
                AI 분석 결과는 100% 정확하지 않으며, 참고용으로만 이용해주세요.
            </p>
        </div>
    );
}
