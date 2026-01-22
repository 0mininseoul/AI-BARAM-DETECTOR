'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { trackEvent, EVENTS } from '@/lib/services/analytics';

export default function AnalyzePage() {
    const [instagramId, setInstagramId] = useState('');
    const [gender, setGender] = useState<'male' | 'female' | ''>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();
    const { user } = useAuth();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!instagramId.trim()) {
            setError('인스타그램 아이디를 입력해주세요.');
            return;
        }

        if (!gender) {
            setError('애인의 성별을 선택해주세요.');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch('/api/analysis/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetInstagramId: instagramId.replace('@', '').trim(),
                    targetGender: gender,
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                if (data.code === 'LIMIT_EXCEEDED') {
                    setError('무료 분석 횟수를 모두 사용했습니다.');
                } else {
                    setError(data.error || '분석 시작에 실패했습니다.');
                }
                return;
            }

            trackEvent(EVENTS.ANALYSIS_START, { targetGender: gender });
            router.push(`/progress/${data.requestId}`);
        } catch (err) {
            setError('서버 오류가 발생했습니다. 다시 시도해주세요.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            {/* 헤더 */}
            <div className="mb-8 text-center">
                <div className="w-16 h-16 mx-auto mb-4">
                    <img src="/logo.png" alt="AI 바람감지기" className="w-full h-full" />
                </div>
                <h1 className="text-xl font-bold text-white">분석 시작하기</h1>
            </div>

            {/* 폼 */}
            <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
                {/* 인스타그램 ID 입력 */}
                <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                        애인의 인스타그램 아이디
                    </label>
                    <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">@</span>
                        <input
                            type="text"
                            value={instagramId}
                            onChange={(e) => setInstagramId(e.target.value)}
                            placeholder="username"
                            className="w-full bg-gray-900 border border-gray-700 rounded-xl py-3.5 pl-9 pr-4 text-white placeholder-gray-500 focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 transition-all"
                        />
                    </div>
                </div>

                {/* 성별 선택 */}
                <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                        애인의 성별
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={() => setGender('male')}
                            className={`py-3.5 px-4 rounded-xl font-medium transition-all ${gender === 'male'
                                    ? 'bg-emerald-400 text-black'
                                    : 'bg-gray-900 text-gray-300 border border-gray-700 hover:border-gray-500'
                                }`}
                        >
                            👨 남성
                        </button>
                        <button
                            type="button"
                            onClick={() => setGender('female')}
                            className={`py-3.5 px-4 rounded-xl font-medium transition-all ${gender === 'female'
                                    ? 'bg-emerald-400 text-black'
                                    : 'bg-gray-900 text-gray-300 border border-gray-700 hover:border-gray-500'
                                }`}
                        >
                            👩 여성
                        </button>
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

                {/* 제출 버튼 */}
                <button
                    type="submit"
                    disabled={loading || !instagramId.trim() || !gender}
                    className="w-full bg-emerald-400 hover:bg-emerald-300 disabled:bg-gray-700 disabled:text-gray-500 text-black font-bold py-4 px-4 rounded-xl transition-all"
                >
                    {loading ? '분석 시작 중...' : '🔍 분석 시작하기'}
                </button>
            </form>

            {/* 면책 조항 */}
            <p className="mt-8 text-xs text-gray-500 text-center max-w-sm">
                AI 분석 결과는 100% 정확하지 않으며, 재미 목적으로만 이용해주세요.
            </p>
        </div>
    );
}
