'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { trackEvent, EVENTS } from '@/lib/services/analytics';

interface PageProps {
    params: Promise<{ requestId: string }>;
}

interface ResultData {
    requestId: string;
    status: string;
    summary: {
        targetInstagramId: string;
        totalFollowers: number;
        mutualFollows: number;
        oppositeGenderCount: number;
        privateAccountsCount: number;
        confidenceScore: number;
    };
    topResult: {
        rank: number;
        instagramId: string;
        profileImage?: string;
        riskScore: number;
        interactions: {
            likes: number;
            normalComments: number;
            intimateComments: number;
            replies: number;
            postTags: number;
            captionMentions: number;
        };
        attractivenessLevel?: string;
        durationMonths?: number;
        isRecentSurge: boolean;
        surgePercentage?: number;
    } | null;
    lockedResults: Array<{
        rank: number;
        riskScore: number;
        isUnlocked: boolean;
        unlockPrice: number;
    }>;
    privateAccounts: Array<{
        instagramId: string;
        profileImage?: string;
    }>;
}

export default function ResultPage({ params }: PageProps) {
    const { requestId } = use(params);
    const [data, setData] = useState<ResultData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showBetaModal, setShowBetaModal] = useState(false);
    const router = useRouter();

    useEffect(() => {
        const fetchResult = async () => {
            try {
                const response = await fetch(`/api/analysis/result/${requestId}`);
                const result = await response.json();

                if (!response.ok) {
                    if (result.status && result.status !== 'completed') {
                        router.push(`/progress/${requestId}`);
                        return;
                    }
                    throw new Error(result.error);
                }

                setData(result);
                trackEvent(EVENTS.VIEW_RESULT, { riskScore: result.topResult?.riskScore });
            } catch (err) {
                setError('결과를 불러오는데 실패했습니다.');
            } finally {
                setLoading(false);
            }
        };

        fetchResult();
    }, [requestId, router]);

    const handleDeepScan = () => {
        trackEvent(EVENTS.CLICK_DEEP_SCAN);
        setShowBetaModal(true);
        trackEvent(EVENTS.VIEW_DEEP_SCAN_BETA_MODAL);
    };

    const handleUnlock = (rank: number) => {
        trackEvent(EVENTS.CLICK_UNLOCK_RANK2);
        // TODO: Polar 결제 연동
        alert('결제 기능은 준비 중입니다.');
    };

    const handleShare = async () => {
        trackEvent(EVENTS.CLICK_SHARE_KAKAO);

        const url = window.location.href;
        const shareData = {
            title: 'AI 바람 감지기 분석 결과',
            text: `${data?.summary.targetInstagramId}님의 인스타 분석 결과를 확인해보세요! 🕵️‍♀️`,
            url: url,
        };

        // 모바일 네이티브 공유 시도
        if (navigator.share) {
            try {
                await navigator.share(shareData);
                return;
            } catch (err) {
                // 공유 취소 또는 미지원 시 클립보드 복사로 fallback
            }
        }

        // 클립보드 복사
        try {
            await navigator.clipboard.writeText(url);
            alert('링크가 클립보드에 복사되었습니다! 친구에게 공유해보세요.');
        } catch (err) {
            alert('공유하기에 실패했습니다. 링크를 직접 복사해주세요.');
        }
    };

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
                <p className="text-red-400 mb-4">{error}</p>
                <button
                    onClick={() => router.push('/analyze')}
                    className="text-emerald-400 underline"
                >
                    다시 시도하기
                </button>
            </div>
        );
    }

    const { summary, topResult, lockedResults, privateAccounts } = data;

    return (
        <div className="min-h-screen bg-black text-white pb-20">
            {/* 헤더 */}
            <div className="p-4 border-b border-gray-800">
                <div className="flex items-center gap-3">
                    <img src="/logo.png" alt="" className="w-8 h-8" />
                    <h1 className="font-bold">분석 결과</h1>
                </div>
            </div>

            {/* 요약 */}
            <div className="p-4">
                <div className="bg-gray-900 rounded-2xl p-4 mb-4">
                    <p className="text-gray-400 text-sm mb-2">
                        @{summary.targetInstagramId} 분석 완료
                    </p>
                    <div className="grid grid-cols-3 gap-4 text-center">
                        <div>
                            <div className="text-xl font-bold text-emerald-400">{summary.mutualFollows}</div>
                            <div className="text-xs text-gray-500">맞팔 계정</div>
                        </div>
                        <div>
                            <div className="text-xl font-bold text-emerald-400">{summary.oppositeGenderCount}</div>
                            <div className="text-xs text-gray-500">이성 계정</div>
                        </div>
                        <div>
                            <div className="text-xl font-bold text-amber-400">{summary.privateAccountsCount}</div>
                            <div className="text-xs text-gray-500">비공개</div>
                        </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-gray-800 text-center">
                        <span className="text-sm text-gray-400">분석 신뢰도: </span>
                        <span className="font-bold text-emerald-400">{summary.confidenceScore.toFixed(1)}%</span>
                    </div>
                </div>

                {/* 1위 결과 */}
                {topResult && (
                    <div className="bg-gradient-to-br from-red-900/30 to-gray-900 rounded-2xl p-4 mb-4 border border-red-500/30">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="bg-red-500 text-white text-xs font-bold px-2 py-1 rounded">1위</span>
                            <span className="text-red-400 font-bold">위험 인물</span>
                        </div>

                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center text-2xl">
                                👤
                            </div>
                            <div>
                                <div className="font-bold text-lg">{topResult.instagramId}</div>
                                <div className="text-3xl font-bold text-red-400">{topResult.riskScore}점</div>
                            </div>
                        </div>

                        {/* 상호작용 요약 */}
                        <div className="flex flex-wrap gap-2 mb-4">
                            <span className="bg-gray-800 px-3 py-1 rounded-full text-sm">
                                ❤️ {topResult.interactions.likes}
                            </span>
                            <span className="bg-gray-800 px-3 py-1 rounded-full text-sm">
                                💬 {topResult.interactions.normalComments + topResult.interactions.intimateComments}
                            </span>
                            {topResult.interactions.postTags > 0 && (
                                <span className="bg-gray-800 px-3 py-1 rounded-full text-sm">
                                    📌 {topResult.interactions.postTags}
                                </span>
                            )}
                        </div>

                        {/* 추가 정보 */}
                        <div className="space-y-2 text-sm">
                            {topResult.durationMonths && (
                                <div className="flex justify-between">
                                    <span className="text-gray-400">알고 지낸 기간</span>
                                    <span>{topResult.durationMonths}개월</span>
                                </div>
                            )}
                            {topResult.attractivenessLevel && (
                                <div className="flex justify-between">
                                    <span className="text-gray-400">외모</span>
                                    <span>
                                        {topResult.attractivenessLevel === 'high' && '🔥 상위권'}
                                        {topResult.attractivenessLevel === 'medium' && '😊 평균'}
                                        {topResult.attractivenessLevel === 'low' && '🙂 보통'}
                                    </span>
                                </div>
                            )}
                            {topResult.isRecentSurge && (
                                <div className="flex justify-between text-red-400">
                                    <span>⚠️ 최근 급증</span>
                                    <span>+{topResult.surgePercentage}%</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* 2위 이하 (잠금) */}
                {lockedResults.length > 0 && (
                    <div className="bg-gray-900 rounded-2xl p-4 mb-4">
                        <h3 className="font-bold mb-3">💡 2위 위험 인물도 확인할까요?</h3>
                        {lockedResults.map((result) => (
                            <div
                                key={result.rank}
                                className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0"
                            >
                                <div className="flex items-center gap-3">
                                    <span className="bg-gray-700 text-white text-xs font-bold px-2 py-1 rounded">
                                        {result.rank}위
                                    </span>
                                    <span className="text-gray-400">●●●●●●●</span>
                                    <span className="font-bold">{result.riskScore}점</span>
                                </div>
                                <button
                                    onClick={() => handleUnlock(result.rank)}
                                    className="bg-emerald-400 text-black text-sm font-bold px-4 py-2 rounded-lg"
                                >
                                    $4.99
                                </button>
                            </div>
                        ))}

                        {/* 딥 스캔 버튼 */}
                        <button
                            onClick={handleDeepScan}
                            className="w-full mt-4 bg-gray-800 text-white font-bold py-3 px-4 rounded-xl border border-gray-700"
                        >
                            🔬 $29.99 딥 스캔하기
                            <span className="block text-xs font-normal text-gray-400 mt-1">
                                외부 댓글까지 전수 분석
                            </span>
                        </button>
                    </div>
                )}

                {/* 비공개 계정 */}
                {privateAccounts.length > 0 && (
                    <div className="bg-gray-900 rounded-2xl p-4 mb-4">
                        <h3 className="font-bold mb-3">🔒 비공개 계정 ({privateAccounts.length}개)</h3>
                        <p className="text-sm text-gray-400 mb-3">
                            이 계정들은 분석이 불가합니다. 직접 확인이 필요할 수 있어요.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {privateAccounts.slice(0, 5).map((account) => (
                                <span
                                    key={account.instagramId}
                                    className="bg-gray-800 px-3 py-1 rounded-full text-sm text-gray-300"
                                >
                                    {account.instagramId}
                                </span>
                            ))}
                            {privateAccounts.length > 5 && (
                                <span className="text-gray-500 text-sm">
                                    +{privateAccounts.length - 5}개 더
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* 공유하기 */}
                <button
                    onClick={handleShare}
                    className="w-full bg-[#FEE500] text-[#3C1E1E] font-bold py-3.5 px-4 rounded-xl flex items-center justify-center gap-2"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3C6.48 3 2 6.48 2 10.76C2 13.67 3.93 16.23 6.83 17.54C6.67 18.06 6.33 19.34 6.33 19.34C6.33 19.34 6.2 19.66 6.43 19.68C6.65 19.7 6.89 19.5 7.15 19.3C7.15 19.3 10.99 15.99 11.5 15.65C11.67 15.66 11.83 15.67 12 15.67C17.52 15.67 22 12.19 22 7.91C22 3.63 17.52 3 12 3Z" />
                    </svg>
                    결과 링크 공유하기
                </button>
            </div>

            {/* 딥 스캔 베타 모달 */}
            {showBetaModal && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
                    <div className="bg-gray-900 rounded-2xl p-6 max-w-sm w-full text-center">
                        <div className="text-4xl mb-4">🔬</div>
                        <h2 className="text-xl font-bold mb-2">딥 스캔 기능 준비중!</h2>
                        <p className="text-gray-400 mb-6">
                            현재 베타 서비스 기간으로 딥 스캔 기능은 아직 준비 중이에요.
                            <br /><br />
                            빠른 시일 내에 오픈할 예정이니 조금만 기다려주세요! 🙏
                        </p>
                        <button
                            onClick={() => setShowBetaModal(false)}
                            className="w-full bg-emerald-400 text-black font-bold py-3 rounded-xl"
                        >
                            확인
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
