import {
    INTERACTION_SCORES,
    getDurationWeight,
    getAttractivenessScore,
    SURGE_BONUS,
} from '@/lib/constants/scoring';
import type { ScoreCalculationInput, ScoreCalculationResult } from '@/lib/types/analysis';

/**
 * 위험도 점수를 계산합니다.
 * 
 * 점수 = (상호작용 점수 + 외모 점수) × 기간 가중치 × 급증 보너스
 */
export function calculateRiskScore(data: ScoreCalculationInput): ScoreCalculationResult {
    // 1. 기본 점수 계산
    const likesScore = data.likesCount * INTERACTION_SCORES.LIKE;
    const normalCommentsScore = data.normalCommentsCount * INTERACTION_SCORES.NORMAL_COMMENT;
    const intimateCommentsScore = data.intimateCommentsCount * INTERACTION_SCORES.INTIMATE_COMMENT;
    const repliesScore = data.repliesCount * INTERACTION_SCORES.REPLY;
    const postTagsScore = data.postTagsCount * INTERACTION_SCORES.POST_TAG;
    const captionMentionsScore = data.captionMentionsCount * INTERACTION_SCORES.CAPTION_MENTION;

    // 외모 점수
    const attractivenessScore = getAttractivenessScore(data.attractivenessLevel);

    const baseScore =
        likesScore +
        normalCommentsScore +
        intimateCommentsScore +
        repliesScore +
        postTagsScore +
        captionMentionsScore +
        attractivenessScore;

    // 2. 기간 가중치 적용
    const durationWeight = getDurationWeight(data.durationMonths);
    const weightedScore = Math.round(baseScore * durationWeight);

    // 3. 급증 보너스 적용
    const surgeMultiplier = data.isRecentSurge ? SURGE_BONUS : 1;
    const finalScore = Math.round(weightedScore * surgeMultiplier);

    return {
        baseScore,
        weightedScore,
        finalScore,
        breakdown: {
            likes: likesScore,
            normalComments: normalCommentsScore,
            intimateComments: intimateCommentsScore,
            replies: repliesScore,
            postTags: postTagsScore,
            captionMentions: captionMentionsScore,
            attractiveness: attractivenessScore,
            durationMultiplier: durationWeight,
            surgeMultiplier,
        },
    };
}

/**
 * 최근 1개월 상호작용이 급증했는지 판단합니다.
 * 기준: 최근 1개월 상호작용 > 이전 평균 × 2
 */
export function detectRecentSurge(
    recentInteractionDates: string[],
    totalInteractions: number
): { isRecentSurge: boolean; surgePercentage: number } {
    if (totalInteractions < 5) {
        return { isRecentSurge: false, surgePercentage: 0 };
    }

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const recentCount = recentInteractionDates.filter(
        (date) => new Date(date) > oneMonthAgo
    ).length;

    const previousCount = totalInteractions - recentCount;

    // 이전 기간이 없으면 급증 판단 불가
    if (previousCount === 0) {
        return { isRecentSurge: false, surgePercentage: 0 };
    }

    // 이전 월 평균 계산 (대략적으로 이전 전체 기간을 사용)
    const previousAverage = previousCount;
    const surgePercentage = ((recentCount - previousAverage) / previousAverage) * 100;

    return {
        isRecentSurge: recentCount > previousAverage * 2,
        surgePercentage: Math.round(surgePercentage),
    };
}

/**
 * 첫 상호작용 날짜로부터 알고 지낸 기간(월)을 계산합니다.
 */
export function calculateDurationMonths(firstInteractionDate: string | undefined): number {
    if (!firstInteractionDate) {
        return 0;
    }

    const firstDate = new Date(firstInteractionDate);
    const now = new Date();

    const months =
        (now.getFullYear() - firstDate.getFullYear()) * 12 +
        (now.getMonth() - firstDate.getMonth());

    return Math.max(0, months);
}
