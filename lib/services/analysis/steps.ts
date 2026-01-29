// 분석 단계 정의 및 유틸리티

export type AnalysisStep =
    | 'pending'
    | 'collect'      // 프로필 + 팔로워/팔로잉 수집 + 맞팔 추출
    | 'profiles'     // 공개 계정 프로필 배치 수집
    | 'gender'       // 성별 분석 (배치)
    | 'features'     // Photogenic/노출 분석 (배치)
    | 'finalize'     // 점수 계산 + 결과 저장
    | 'completed'
    | 'failed';

// 단계별 진행률 범위
export const STEP_PROGRESS: Record<AnalysisStep, { min: number; max: number; label: string }> = {
    pending: { min: 0, max: 0, label: '분석 대기 중...' },
    collect: { min: 5, max: 30, label: '팔로워/팔로잉 수집 중...' },
    profiles: { min: 30, max: 50, label: '공개 계정 프로필 수집 중...' },
    gender: { min: 50, max: 70, label: '성별 분석 중...' },
    features: { min: 70, max: 90, label: '외모/노출 분석 중...' },
    finalize: { min: 90, max: 100, label: '결과 저장 중...' },
    completed: { min: 100, max: 100, label: '분석 완료!' },
    failed: { min: 0, max: 0, label: '분석 실패' },
};

// 다음 단계 결정
export function getNextStep(currentStep: AnalysisStep): AnalysisStep {
    const order: AnalysisStep[] = ['pending', 'collect', 'profiles', 'gender', 'features', 'finalize', 'completed'];
    const currentIndex = order.indexOf(currentStep);
    if (currentIndex === -1 || currentIndex >= order.length - 1) {
        return 'completed';
    }
    return order[currentIndex + 1];
}

// 배치 처리용 인덱스 계산
export const BATCH_SIZE = 50; // 각 배치당 처리할 계정 수

export function calculateBatchProgress(
    step: AnalysisStep,
    batchIndex: number,
    totalBatches: number
): number {
    const stepProgress = STEP_PROGRESS[step];
    const range = stepProgress.max - stepProgress.min;
    const batchProgress = totalBatches > 0 ? (batchIndex / totalBatches) * range : 0;
    return Math.round(stepProgress.min + batchProgress);
}

// step_data 타입 정의
export interface StepData {
    // collect 단계 결과
    mutualFollows?: string[];
    publicAccounts?: Array<{
        username: string;
        profilePicUrl?: string;
        isPrivate: boolean;
    }>;

    // profiles 단계 결과
    accountsWithPosts?: Array<{
        profile: {
            username: string;
            profilePicUrl?: string;
            fullName?: string;
            bio?: string;
            isPrivate: boolean;
        };
        recentPosts: Array<{
            imageUrl?: string;
            taggedUsers?: string[];
            mentionedUsers?: string[];
        }>;
    }>;

    // gender 단계 결과
    genderResults?: Record<string, {
        gender: 'male' | 'female' | 'unknown';
        confidence: number;
        reasoning?: string;
    }>;
    femaleAccounts?: Array<{
        profile: {
            username: string;
            profilePicUrl?: string;
            fullName?: string;
            bio?: string;
            isPrivate: boolean;
        };
        recentPosts: Array<{
            imageUrl?: string;
            taggedUsers?: string[];
            mentionedUsers?: string[];
        }>;
    }>;
    genderBatchIndex?: number;

    // profiles 단계 결과
    profileBatchIndex?: number;

    // features 단계 결과
    photogenicResults?: Record<string, {
        photogenicGrade: number;
        confidence: number;
    }>;
    exposureResults?: Record<string, {
        skinVisibility: 'high' | 'low';
        confidence: number;
    }>;
    featureBatchIndex?: number;
}

// profiles 단계 배치 크기 (더 작게 설정하여 타임아웃 방지)
export const PROFILE_BATCH_SIZE = 30;
