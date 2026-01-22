interface ConfidenceData {
    totalInteractions: number;
    oppositeGenderCount: number;
    averagePostsPerAccount: number;
    genderConfidences: number[];
}

/**
 * 분석 신뢰도 점수를 계산합니다.
 * 
 * 신뢰도 = 상호작용 데이터 충분도 × 평균 성별 판단 confidence × 100
 */
export function calculateConfidenceScore(data: ConfidenceData): number {
    // 1. 상호작용 데이터 충분도 계산
    const expectedInteractions =
        data.oppositeGenderCount * data.averagePostsPerAccount * 0.1;

    const interactionSufficiency = Math.min(
        data.totalInteractions / Math.max(expectedInteractions, 1),
        1.0
    );

    // 2. 평균 성별 판단 confidence
    const avgGenderConfidence =
        data.genderConfidences.length > 0
            ? data.genderConfidences.reduce((a, b) => a + b, 0) / data.genderConfidences.length
            : 0.5;

    // 3. 최종 신뢰도 계산
    const confidence = interactionSufficiency * avgGenderConfidence * 100;

    return Math.round(confidence * 10) / 10; // 소수점 1자리
}
