'use client';

import { useEffect, use, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAnalysisProgress } from '@/hooks/useAnalysisProgress';

interface PageProps {
    params: Promise<{ requestId: string }>;
}

export default function ProgressPage({ params }: PageProps) {
    const { requestId } = use(params);
    const { data, loading, error } = useAnalysisProgress(requestId);
    const router = useRouter();
    const isRunningStep = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    // 단계별 분석 실행 함수
    const runNextStep = useCallback(async () => {
        if (isRunningStep.current) return;
        isRunningStep.current = true;

        try {
            abortControllerRef.current = new AbortController();

            const response = await fetch('/api/analysis/step', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId }),
                signal: abortControllerRef.current.signal,
            });

            const result = await response.json();

            if (!response.ok) {
                console.error('Step failed:', result.error);
                isRunningStep.current = false;
                return;
            }

            // 완료되지 않았으면 다음 단계 실행
            if (!result.done) {
                isRunningStep.current = false;
                // 약간의 딜레이 후 다음 단계 호출
                setTimeout(() => runNextStep(), 500);
            }
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                console.log('Step aborted');
            } else {
                console.error('Failed to run step:', err);
            }
            isRunningStep.current = false;
        }
    }, [requestId]);

    // pending 또는 processing 상태이면 분석 단계 실행
    useEffect(() => {
        if (
            (data?.status === 'pending' || data?.status === 'processing') &&
            !isRunningStep.current
        ) {
            runNextStep();
        }
    }, [data?.status, runNextStep]);

    // 컴포넌트 언마운트 시 정리
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    // 완료되면 결과 페이지로 이동
    useEffect(() => {
        if (data?.status === 'completed') {
            router.push(`/result/${requestId}`);
        }
    }, [data?.status, requestId, router]);

    if (loading) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
                <p className="text-red-400 mb-4">{error || '분석 요청을 찾을 수 없습니다.'}</p>
                <button
                    onClick={() => router.push('/analyze')}
                    className="text-emerald-400 underline"
                >
                    다시 시도하기
                </button>
            </div>
        );
    }

    if (data.status === 'failed') {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
                <div className="text-center">
                    <div className="text-4xl mb-4">❌</div>
                    <h1 className="text-xl font-bold text-white mb-2">분석 실패</h1>
                    <p className="text-gray-400 mb-6">분석 중 오류가 발생했습니다.</p>
                    <button
                        onClick={() => router.push('/analyze')}
                        className="bg-emerald-400 text-black font-bold py-3 px-6 rounded-xl"
                    >
                        다시 시도하기
                    </button>
                </div>
            </div>
        );
    }

    // 진행 단계
    const steps = [
        { label: '팔로워 수집', threshold: 15 },
        { label: '맞팔 확인', threshold: 30 },
        { label: '성별 판단', threshold: 50 },
        { label: '상호작용 분석', threshold: 75 },
        { label: '점수 계산', threshold: 95 },
    ];

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            {/* 로고 */}
            <div className="w-16 h-16 mb-6">
                <img src="/logo.png" alt="AI 바람감지기" className="w-full h-full animate-pulse" />
            </div>

            {/* 제목 */}
            <h1 className="text-xl font-bold text-white mb-2">분석 중...</h1>
            <p className="text-gray-400 mb-8">{data.progressStep || '분석을 준비하고 있습니다.'}</p>

            {/* 프로그레스 바 */}
            <div className="w-full max-w-sm mb-8">
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-emerald-400 transition-all duration-500 ease-out"
                        style={{ width: `${data.progress}%` }}
                    />
                </div>
                <div className="flex justify-between mt-2 text-sm text-gray-500">
                    <span>{data.progress}%</span>
                    <span>약 3~5분 소요</span>
                </div>
            </div>

            {/* 단계 체크리스트 */}
            <div className="w-full max-w-sm space-y-3">
                {steps.map((step, index) => {
                    const isComplete = data.progress >= step.threshold;
                    const isCurrent =
                        data.progress >= (steps[index - 1]?.threshold || 0) &&
                        data.progress < step.threshold;

                    return (
                        <div
                            key={step.label}
                            className={`flex items-center gap-3 p-3 rounded-xl ${isComplete
                                ? 'bg-emerald-400/10 border border-emerald-400/30'
                                : isCurrent
                                    ? 'bg-gray-800 border border-gray-700'
                                    : 'bg-gray-900/50 border border-gray-800'
                                }`}
                        >
                            <div
                                className={`w-6 h-6 rounded-full flex items-center justify-center ${isComplete
                                    ? 'bg-emerald-400 text-black'
                                    : isCurrent
                                        ? 'bg-gray-700 border-2 border-emerald-400'
                                        : 'bg-gray-800 border border-gray-600'
                                    }`}
                            >
                                {isComplete ? '✓' : isCurrent ? '⋯' : index + 1}
                            </div>
                            <span
                                className={
                                    isComplete
                                        ? 'text-emerald-400 font-medium'
                                        : isCurrent
                                            ? 'text-white'
                                            : 'text-gray-500'
                                }
                            >
                                {step.label}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* 이탈 안내 */}
            <div className="mt-8 p-4 bg-gray-900/50 rounded-xl border border-gray-800 max-w-sm">
                <p className="text-sm text-gray-400 text-center">
                    💡 페이지를 닫아도 분석은 계속됩니다.
                    <br />
                    완료되면 이메일로 알려드릴게요!
                </p>
            </div>
        </div>
    );
}
