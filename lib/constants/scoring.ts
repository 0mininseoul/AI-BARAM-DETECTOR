// 점수 계산 상수

// 기본 상호작용 점수
export const INTERACTION_SCORES = {
    LIKE: 1,
    NORMAL_COMMENT: 3,
    INTIMATE_COMMENT: 10,  // 친밀한 댓글은 일반 댓글의 3배 이상 가중치
    REPLY: 5,
    POST_TAG: 3,
    CAPTION_MENTION: 5,
} as const;

// 외모 점수
export const ATTRACTIVENESS_SCORES = {
    HIGH: 70,
    MEDIUM: 10,
    LOW: 0,
} as const;

// 기간 가중치
export const DURATION_WEIGHTS = {
    LESS_THAN_6_MONTHS: 1.0,
    SIX_TO_12_MONTHS: 1.3,
    MORE_THAN_12_MONTHS: 1.5,
} as const;

// 급증 보너스
export const SURGE_BONUS = 1.5;

// 급증 판단 기준 (최근 1개월 상호작용이 이전 평균의 N배 이상)
export const SURGE_THRESHOLD = 2;

// 성별 판단 신뢰도 임계값
export const GENDER_CONFIDENCE_THRESHOLD = 0.7;

// 기간 계산 함수
export function getDurationWeight(months: number): number {
    if (months >= 12) {
        return DURATION_WEIGHTS.MORE_THAN_12_MONTHS;
    } else if (months >= 6) {
        return DURATION_WEIGHTS.SIX_TO_12_MONTHS;
    }
    return DURATION_WEIGHTS.LESS_THAN_6_MONTHS;
}

// 외모 점수 계산 함수
export function getAttractivenessScore(level: 'high' | 'medium' | 'low' | null): number {
    switch (level) {
        case 'high':
            return ATTRACTIVENESS_SCORES.HIGH;
        case 'medium':
            return ATTRACTIVENESS_SCORES.MEDIUM;
        default:
            return ATTRACTIVENESS_SCORES.LOW;
    }
}
