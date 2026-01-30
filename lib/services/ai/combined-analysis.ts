import { analyzeWithGemini, imageUrlToBase64 } from './gemini';
import { COMBINED_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import { GENDER_CONFIDENCE_THRESHOLD } from '@/lib/constants/scoring';
import type { CombinedAnalysisResponse } from '@/lib/types/analysis';
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';

interface CombinedAnalysisInput {
    profile: InstagramProfile;
    recentPosts: InstagramPost[];
}

/**
 * 인스타그램 프로필의 성별 + (여성인 경우) 외모/노출을 AI로 통합 분석
 * 하나의 API 호출로 모든 분석을 수행하여 토큰 효율성 극대화
 */
export async function analyzeCombined(
    input: CombinedAnalysisInput
): Promise<CombinedAnalysisResponse> {
    const { profile, recentPosts } = input;

    // 이미지 수집 (프로필 + 최근 피드 최대 10장)
    const imageUrls: string[] = [];

    if (profile.profilePicUrl) {
        imageUrls.push(profile.profilePicUrl);
    }

    for (const post of recentPosts.slice(0, 9)) {
        if (post.imageUrl) {
            imageUrls.push(post.imageUrl);
        }
    }

    // 이미지를 base64로 변환 (한 번만 수행)
    const images: string[] = [];
    for (const url of imageUrls) {
        try {
            const base64 = await imageUrlToBase64(url);
            images.push(base64);
        } catch (error) {
            console.warn(`Failed to convert image: ${url}`, error);
        }
    }

    // 프롬프트 구성
    const prompt = COMBINED_ANALYSIS_PROMPT
        .replace('{profileImageDescription}', profile.profilePicUrl ? '첨부된 이미지 참조' : '없음')
        .replace('{username}', profile.username)
        .replace('{fullName}', profile.fullName || '없음')
        .replace('{bio}', profile.bio || '없음')
        .replace('{feedImagesDescription}', images.length > 1 ? '첨부된 이미지들 참조' : '없음');

    // AI 분석 수행 (한 번의 호출로 모든 분석)
    const result = await analyzeWithGemini<CombinedAnalysisResponse>(prompt, images);

    // genderConfidence가 임계값 미만이면 unknown 처리
    if (result.genderConfidence < GENDER_CONFIDENCE_THRESHOLD) {
        return {
            gender: 'unknown',
            genderConfidence: result.genderConfidence,
            genderReasoning: result.genderReasoning,
        };
    }

    return result;
}

/**
 * 여러 계정을 일괄 통합 분석
 */
export async function analyzeCombinedBatch(
    accounts: { profile: InstagramProfile; recentPosts: InstagramPost[] }[],
    batchSize: number = 5
): Promise<Map<string, CombinedAnalysisResponse>> {
    const results = new Map<string, CombinedAnalysisResponse>();

    // 병렬 처리 (동시에 batchSize개씩)
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzeCombined(account);
                    return { username: account.profile.username, result };
                } catch (error) {
                    console.error(`Combined analysis failed for ${account.profile.username}:`, error);
                    return {
                        username: account.profile.username,
                        result: {
                            gender: 'unknown' as const,
                            genderConfidence: 0,
                            genderReasoning: 'Analysis failed',
                        },
                    };
                }
            })
        );

        for (const { username, result } of batchResults) {
            results.set(username, result);
        }
    }

    return results;
}
