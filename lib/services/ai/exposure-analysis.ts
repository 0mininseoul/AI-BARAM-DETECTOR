import { analyzeWithGemini, imageUrlToBase64 } from './gemini';
import { EXPOSURE_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import type { ExposureAnalysisResponse } from '@/lib/types/analysis';

/**
 * 인스타그램 계정 주인의 노출 정도(Skin Visibility)를 AI로 분석
 */
export async function analyzeExposure(
    profilePicUrl: string | undefined,
    postImageUrls: string[]
): Promise<ExposureAnalysisResponse> {
    // 이미지 수집 (프로필 + 피드 최대 10장)
    const imageUrls: string[] = [];

    if (profilePicUrl) {
        imageUrls.push(profilePicUrl);
    }

    imageUrls.push(...postImageUrls.slice(0, 9));

    // 이미지가 없으면 분석 불가
    if (imageUrls.length === 0) {
        return {
            ownerIdentified: false,
            skinVisibility: 'low',
            confidence: 0,
            reasoning: '분석할 이미지가 없습니다.',
        };
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

    if (images.length === 0) {
        return {
            ownerIdentified: false,
            skinVisibility: 'low',
            confidence: 0,
            reasoning: '이미지 변환에 실패했습니다.',
        };
    }

    // 프롬프트 구성
    const prompt = EXPOSURE_ANALYSIS_PROMPT.replace(
        '{imageDescriptions}',
        `총 ${images.length}개의 이미지가 첨부되어 있습니다. 첫 번째는 프로필 사진입니다.`
    );

    // AI 분석 수행
    try {
        const result = await analyzeWithGemini<ExposureAnalysisResponse>(prompt, images);
        return result;
    } catch (error) {
        console.error('Exposure analysis failed:', error);
        return {
            ownerIdentified: false,
            skinVisibility: 'low',
            confidence: 0,
            reasoning: '분석 중 오류가 발생했습니다.',
        };
    }
}

/**
 * 여러 계정의 노출 정도를 일괄 분석
 */
export async function analyzeExposureBatch(
    accounts: { username: string; profilePicUrl?: string; postImageUrls: string[] }[]
): Promise<Map<string, ExposureAnalysisResponse>> {
    const results = new Map<string, ExposureAnalysisResponse>();

    // 병렬 처리 (동시에 3개씩)
    const batchSize = 3;
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzeExposure(
                        account.profilePicUrl,
                        account.postImageUrls
                    );
                    return { username: account.username, result };
                } catch (error) {
                    console.error(`Exposure analysis failed for ${account.username}:`, error);
                    return {
                        username: account.username,
                        result: {
                            ownerIdentified: false,
                            skinVisibility: 'low' as const,
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
