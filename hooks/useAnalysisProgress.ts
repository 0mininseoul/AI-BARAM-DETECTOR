'use client';

import { useEffect, useState, useCallback, useRef } from 'react';

interface AnalysisProgress {
    id: string;
    pipelineVersion: 'v1' | 'v2';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string | null;
    errorMessage: string | null;
    backgroundProcessing: boolean;
}

interface V2ProgressRead {
    snapshot: {
        requestId: string;
        status: 'queued' | 'processing' | 'completed' | 'failed' | 'upgrade_required';
        progressBp: number;
        backgroundProcessing: boolean;
        tracks: Record<string, { state: string; stageCode: string }>;
    };
    events: Array<{ copyCode: string }>;
}

const V2_PROGRESS_COPY: Readonly<Record<string, string>> = {
    TARGET_PROFILE_READY: '대상 계정 프로필을 확인했습니다.',
    RELATIONSHIPS_COLLECTING: '팔로워와 팔로잉 목록을 수집하고 있습니다.',
    RELATIONSHIPS_COLLECTED: '맞팔 관계를 정리했습니다.',
    PUBLIC_PROFILES_COLLECTING: '공개 프로필을 확인하고 있습니다.',
    PROFILE_SCREENING: '맞팔 계정을 판독하고 있습니다.',
    PROFILES_SCREENED: '계정 특징 판독을 진행했습니다.',
    TARGET_INTERACTIONS_COLLECTING: '대상 계정의 상호작용을 확인하고 있습니다.',
    SHORTLIST_INTERACTIONS_COLLECTING: '주요 후보와의 상호작용을 비교하고 있습니다.',
    SHORTLIST_READY: '정밀 판독할 후보를 추렸습니다.',
    CANDIDATES_RANKING: '위험도 순위를 계산하고 있습니다.',
    HIGH_RISK_NARRATIVES_WRITING: '고위험 후보의 총평을 정리하고 있습니다.',
    RESULT_FINALIZING: '최종 판독 결과를 정리하고 있습니다.',
    ANALYSIS_COMPLETED: '판독이 완료됐습니다.',
};

function v2ProgressCopy(progress: V2ProgressRead): string {
    const latestCopyCode = progress.events.at(-1)?.copyCode;
    const activeStageCode = Object.values(progress.snapshot.tracks)
        .find(track => track.state === 'running')?.stageCode;
    const code = latestCopyCode || activeStageCode;
    return (code && V2_PROGRESS_COPY[code]) || '서버에서 판독을 진행하고 있습니다.';
}

function mapV2Status(status: V2ProgressRead['snapshot']['status']): AnalysisProgress['status'] {
    if (status === 'queued') return 'pending';
    if (status === 'upgrade_required') return 'failed';
    return status;
}

export function useAnalysisProgress(requestId: string) {
    const [data, setData] = useState<AnalysisProgress | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const hasDataRef = useRef(false);
    const v2ProgressUrlRef = useRef<string | null>(null);

    // 초기 데이터 로드
    const fetchData = useCallback(async () => {
        try {
            let response = await fetch(
                v2ProgressUrlRef.current
                    || `/api/analysis/status/${encodeURIComponent(requestId)}`,
                { cache: 'no-store' }
            );
            let payload = await response.json() as Record<string, unknown>;
            if (
                response.status === 409
                && payload.code === 'V2_ROUTE_REQUIRED'
                && payload.pipelineVersion === 'v2'
                && typeof payload.progressUrl === 'string'
                && payload.progressUrl.startsWith('/api/analysis/progress/')
            ) {
                v2ProgressUrlRef.current = payload.progressUrl;
                response = await fetch(payload.progressUrl, { cache: 'no-store' });
                payload = await response.json() as Record<string, unknown>;
            }
            if (!response.ok) {
                throw new Error(`Analysis status request failed (${response.status}).`);
            }

            if (v2ProgressUrlRef.current) {
                const progress = payload as unknown as V2ProgressRead;
                setData({
                    id: progress.snapshot.requestId,
                    pipelineVersion: 'v2',
                    status: mapV2Status(progress.snapshot.status),
                    progress: progress.snapshot.progressBp / 100,
                    progressStep: v2ProgressCopy(progress),
                    errorMessage: progress.snapshot.status === 'upgrade_required'
                        ? '현재 계정 규모에 맞는 플랜을 다시 확인해주세요.'
                        : progress.snapshot.status === 'failed'
                            ? '판독 처리 중 오류가 발생했습니다.'
                            : null,
                    backgroundProcessing: progress.snapshot.backgroundProcessing,
                });
                hasDataRef.current = true;
                setError(null);
                return;
            }

            const analysisRequest = payload as unknown as {
                requestId: string;
                pipelineVersion: 'v1';
                status: AnalysisProgress['status'];
                progress: number;
                progressStep: string | null;
                errorMessage: string | null;
                backgroundProcessing: boolean;
            };

            setData({
                id: analysisRequest.requestId,
                pipelineVersion: analysisRequest.pipelineVersion,
                status: analysisRequest.status,
                progress: analysisRequest.progress,
                progressStep: analysisRequest.progressStep,
                errorMessage: analysisRequest.errorMessage,
                backgroundProcessing: analysisRequest.backgroundProcessing === true,
            });
            hasDataRef.current = true;
            setError(null);
        } catch (err) {
            console.error('Failed to fetch analysis progress:', err);
            if (!hasDataRef.current) {
                setError('분석 요청을 찾을 수 없습니다.');
            }
        } finally {
            setLoading(false);
        }
    }, [requestId]);

    useEffect(() => {
        void fetchData();
    }, [fetchData]);

    // Poll only the explicitly granted progress columns. The paid pipeline remains owned by
    // Cloud Tasks (or the progress page fallback), so polling never starts a paid step itself.
    useEffect(() => {
        if (data?.status === 'completed' || data?.status === 'failed') return;
        const interval = setInterval(fetchData, 5_000);
        return () => clearInterval(interval);
    }, [data?.status, fetchData]);

    return { data, loading, error, refetch: fetchData };
}
