import { analyzeWithGemini, imageUrlToBase64 } from './gemini';
import { GENDER_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import { GENDER_CONFIDENCE_THRESHOLD } from '@/lib/constants/scoring';
import type { GenderAnalysisResponse } from '@/lib/types/analysis';
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';

interface GenderAnalysisInput {
    profile: InstagramProfile;
    recentPosts: InstagramPost[];
}

/**
 * 인스타그램 프로필의 성별을 AI로 분석
 */
export async function analyzeGender(
    input: GenderAnalysisInput
): Promise<GenderAnalysisResponse> {
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

    // 이미지를 base64로 변환
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
    const prompt = GENDER_ANALYSIS_PROMPT
        .replace('{profileImageDescription}', profile.profilePicUrl ? '첨부된 이미지 참조' : '없음')
        .replace('{username}', profile.username)
        .replace('{fullName}', profile.fullName || '없음')
        .replace('{bio}', profile.bio || '없음')
        .replace('{feedImagesDescription}', images.length > 1 ? '첨부된 이미지들 참조' : '없음');

    // AI 분석 수행
    const result = await analyzeWithGemini<GenderAnalysisResponse>(prompt, images);

    // confidence가 임계값 미만이면 unknown 처리
    if (result.confidence < GENDER_CONFIDENCE_THRESHOLD) {
        return {
            gender: 'unknown',
            confidence: result.confidence,
            reasoning: result.reasoning,
        };
    }

    return result;
}

/**
 * 여러 계정의 성별을 일괄 분석
 */
export async function analyzeGenderBatch(
    accounts: { profile: InstagramProfile; recentPosts: InstagramPost[] }[]
): Promise<Map<string, GenderAnalysisResponse>> {
    const results = new Map<string, GenderAnalysisResponse>();

    // 병렬 처리 (동시에 5개씩)
    const batchSize = 5;
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzeGender(account);
                    return { username: account.profile.username, result };
                } catch (error) {
                    console.error(`Gender analysis failed for ${account.profile.username}:`, error);
                    return {
                        username: account.profile.username,
                        result: {
                            gender: 'unknown' as const,
                            confidence: 0,
                            reasoning: 'Analysis failed',
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
