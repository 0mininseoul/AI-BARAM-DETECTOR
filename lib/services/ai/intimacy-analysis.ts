import { analyzeWithGemini } from './gemini';
import { INTIMACY_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import type { IntimacyAnalysisResponse } from '@/lib/types/analysis';

interface CommentForAnalysis {
    authorId: string;
    postOwnerId: string;
    commentText: string;
}

/**
 * 댓글의 친밀도를 AI로 분석
 */
export async function analyzeCommentIntimacy(
    comment: CommentForAnalysis
): Promise<IntimacyAnalysisResponse> {
    const { authorId, postOwnerId, commentText } = comment;

    // 너무 짧은 댓글은 일반 처리
    if (commentText.length < 2) {
        return {
            intimacyLevel: 'normal',
            confidence: 1.0,
            indicators: [],
            reasoning: '댓글이 너무 짧아 분석 불가',
        };
    }

    // 프롬프트 구성
    const prompt = INTIMACY_ANALYSIS_PROMPT
        .replace('{authorId}', authorId)
        .replace('{postOwnerId}', postOwnerId)
        .replace('{commentText}', commentText);

    // AI 분석 수행
    const result = await analyzeWithGemini<IntimacyAnalysisResponse>(prompt);

    return result;
}

/**
 * 여러 댓글의 친밀도를 일괄 분석
 */
export async function analyzeCommentIntimacyBatch(
    comments: CommentForAnalysis[]
): Promise<Map<string, IntimacyAnalysisResponse>> {
    const results = new Map<string, IntimacyAnalysisResponse>();

    // 병렬 처리 (동시에 10개씩 - 텍스트만이라 빠름)
    const batchSize = 10;
    for (let i = 0; i < comments.length; i += batchSize) {
        const batch = comments.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (comment, index) => {
                try {
                    const result = await analyzeCommentIntimacy(comment);
                    return { key: `${i + index}`, result };
                } catch (error) {
                    console.error(`Intimacy analysis failed:`, error);
                    return {
                        key: `${i + index}`,
                        result: {
                            intimacyLevel: 'normal' as const,
                            confidence: 0,
                            indicators: [],
                            reasoning: 'Analysis failed',
                        },
                    };
                }
            })
        );

        for (const { key, result } of batchResults) {
            results.set(key, result);
        }
    }

    return results;
}
