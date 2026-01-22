import { analyzeWithGemini, imageUrlToBase64 } from './gemini';
import { APPEARANCE_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import type { AppearanceAnalysisResponse } from '@/lib/types/analysis';

/**
 * 인스타그램 계정 주인의 외모를 AI로 분석
 */
export async function analyzeAppearance(
    profilePicUrl: string | undefined,
    postImageUrls: string[]
): Promise<AppearanceAnalysisResponse> {
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
            attractivenessLevel: 'low',
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
            attractivenessLevel: 'low',
            confidence: 0,
            reasoning: '이미지 변환에 실패했습니다.',
        };
    }

    // 프롬프트 구성
    const prompt = APPEARANCE_ANALYSIS_PROMPT.replace(
        '{imageDescriptions}',
        `총 ${images.length}개의 이미지가 첨부되어 있습니다. 첫 번째는 프로필 사진입니다.`
    );

    // AI 분석 수행
    const result = await analyzeWithGemini<AppearanceAnalysisResponse>(prompt, images);

    return result;
}
