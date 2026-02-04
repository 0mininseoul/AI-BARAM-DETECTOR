import { NextResponse } from 'next/server';
import { getDailyTokenUsage } from '@/lib/services/ai/gemini';
import { getCacheStats } from '@/lib/services/ai/combined-analysis';

/**
 * 토큰 사용량 및 캐시 통계 조회 API
 * GET /api/admin/token-usage?days=7
 */
export async function GET(request: Request) {
    // 간단한 API 키 인증 (프로덕션에서는 더 강력한 인증 필요)
    const authHeader = request.headers.get('authorization');
    const expectedKey = process.env.ADMIN_API_KEY;

    if (expectedKey && authHeader !== `Bearer ${expectedKey}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const days = parseInt(searchParams.get('days') || '7', 10);

        const [tokenUsage, cacheStats] = await Promise.all([
            getDailyTokenUsage(days),
            getCacheStats(),
        ]);

        // 요약 통계 계산
        const summary = {
            totalApiCalls: tokenUsage.reduce((sum, d) => sum + d.apiCalls, 0),
            totalCacheHits: tokenUsage.reduce((sum, d) => sum + d.cacheHits, 0),
            totalTokens: tokenUsage.reduce((sum, d) => sum + d.totalTokens, 0),
            cacheHitRate: 0,
            estimatedCostUsd: 0,
        };

        // 캐시 히트율 계산
        if (summary.totalApiCalls > 0) {
            summary.cacheHitRate = Math.round(
                (summary.totalCacheHits / (summary.totalApiCalls + summary.totalCacheHits)) * 100
            );
        }

        // 예상 비용 계산 (Gemini Flash 기준: 입력 $0.075/1M, 출력 $0.30/1M)
        // 대략적 추정: 입력 80%, 출력 20%
        const inputTokens = summary.totalTokens * 0.8;
        const outputTokens = summary.totalTokens * 0.2;
        summary.estimatedCostUsd = (inputTokens * 0.075 + outputTokens * 0.30) / 1_000_000;

        return NextResponse.json({
            success: true,
            period: `Last ${days} days`,
            summary,
            cache: cacheStats,
            daily: tokenUsage,
        });
    } catch (error) {
        console.error('Token usage API error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Failed to get token usage' },
            { status: 500 }
        );
    }
}
