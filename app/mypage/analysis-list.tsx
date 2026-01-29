'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface AnalysisRequest {
    id: string;
    target_instagram_id: string;
    status: string;
    created_at: string;
    plan_type?: string;
    // 필요한 다른 필드들...
}

interface Props {
    initialAnalyses: AnalysisRequest[];
}

export default function AnalysisList({ initialAnalyses }: Props) {
    const [analyses, setAnalyses] = useState<AnalysisRequest[]>(initialAnalyses);
    const [loadingId, setLoadingId] = useState<string | null>(null);
    const router = useRouter();
    const supabase = createClient();

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation(); // 카드 클릭 이벤트 전파 방지

        if (!confirm('정말 이 분석 기록을 삭제하시겠습니까? 복구할 수 없습니다.')) {
            return;
        }

        setLoadingId(id);

        try {
            const { error } = await supabase
                .from('analysis_requests')
                .delete()
                .eq('id', id);

            if (error) {
                alert('삭제에 실패했습니다.');
                console.error(error);
            } else {
                setAnalyses(prev => prev.filter(item => item.id !== id));
            }
        } catch (err) {
            console.error(err);
            alert('오류가 발생했습니다.');
        } finally {
            setLoadingId(null);
        }
    };

    const handleCardClick = (id: string, status: string) => {
        if (status === 'completed') {
            router.push(`/result/${id}`);
        } else if (status === 'processing' || status === 'pending') {
            // 진행 중이면 진행 페이지로 (또는 상태 확인 API 호출)
            router.push(`/progress/${id}`); // progress 페이지가 있다고 가정
        } else {
            alert('완료되지 않은 분석입니다.');
        }
    };

    if (analyses.length === 0) {
        return (
            <div className="text-center py-20 bg-gray-900/50 rounded-2xl border border-gray-800">
                <p className="text-gray-500 mb-4">아직 분석 기록이 없습니다.</p>
                <button
                    onClick={() => router.push('/analyze')}
                    className="bg-pink-600 hover:bg-pink-500 text-white font-bold py-2 px-6 rounded-full transition-colors"
                >
                    분석 시작하기
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {analyses.map((item) => (
                <div
                    key={item.id}
                    onClick={() => handleCardClick(item.id, item.status)}
                    className="bg-gray-900 border border-gray-800 rounded-xl p-5 cursor-pointer hover:border-pink-500/50 transition-all active:scale-[0.98] relative group"
                >
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                            <h3 className="font-bold text-lg text-white">
                                @{item.target_instagram_id}
                            </h3>
                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${item.plan_type === 'standard'
                                    ? 'bg-purple-900/50 text-purple-300 border border-purple-500/30'
                                    : 'bg-gray-800 text-gray-400 border border-gray-700'
                                }`}>
                                {item.plan_type === 'standard' ? 'Standard' : 'Basic'}
                            </span>
                        </div>

                        {/* 상태 뱃지 */}
                        {item.status === 'completed' ? (
                            <span className="text-xs bg-green-900/30 text-green-400 px-2 py-1 rounded border border-green-500/30">
                                분석완료
                            </span>
                        ) : (
                            <span className="text-xs bg-yellow-900/30 text-yellow-400 px-2 py-1 rounded border border-yellow-500/30">
                                {item.status === 'processing' ? '분석중' : '대기중'}
                            </span>
                        )}
                    </div>

                    <div className="text-gray-500 text-sm">
                        {new Date(item.created_at).toLocaleDateString()} {new Date(item.created_at).toLocaleTimeString()}
                    </div>

                    {/* 삭제 버튼 (오른쪽 하단 또는 모서리) */}
                    <button
                        onClick={(e) => handleDelete(e, item.id)}
                        disabled={loadingId === item.id}
                        className="absolute bottom-4 right-4 p-2 text-gray-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors z-10 opacity-0 group-hover:opacity-100 mobile:opacity-100" // 모바일에서는 항상 보이게 하거나... 터치 디바이스 고려 필요
                        title="기록 삭제"
                    >
                        {loadingId === item.id ? (
                            <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        )}
                    </button>
                </div>
            ))}
        </div>
    );
}
