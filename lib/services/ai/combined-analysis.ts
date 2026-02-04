import { analyzeWithGemini, imageUrlToBase64, logTokenUsage } from './gemini';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { COMBINED_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import { GENDER_CONFIDENCE_THRESHOLD } from '@/lib/constants/scoring';
import type { CombinedAnalysisResponse } from '@/lib/types/analysis';
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';

interface CombinedAnalysisInput {
    profile: InstagramProfile;
    recentPosts: InstagramPost[];
    requestId?: string; // 토큰 추적용
}

/**
 * 캐시에서 분석 결과 조회
 */
async function getCachedAnalysis(username: string): Promise<CombinedAnalysisResponse | null> {
    try {
        const { data, error } = await supabaseAdmin
            .from('ai_analysis_cache')
            .select('analysis_result')
            .eq('instagram_username', username)
            .single();

        if (error || !data) {
            return null;
        }

        console.log(`Cache HIT for ${username}`);
        return data.analysis_result as CombinedAnalysisResponse;
    } catch {
        return null;
    }
}

/**
 * 분석 결과를 캐시에 저장 (영구 저장, 만료 없음)
 */
async function setCachedAnalysis(
    username: string,
    result: CombinedAnalysisResponse,
    profilePicUrl?: string
): Promise<void> {
    try {
        await supabaseAdmin
            .from('ai_analysis_cache')
            .upsert({
                instagram_username: username,
                analysis_result: result,
                profile_pic_url: profilePicUrl,
                updated_at: new Date().toISOString(),
            }, {
                onConflict: 'instagram_username',
            });

        console.log(`Cache SET for ${username}`);
    } catch (error) {
        // 캐시 저장 실패는 분석 실패로 이어지지 않도록
        console.warn(`Failed to cache analysis for ${username}:`, error);
    }
}

/**
 * 인스타그램 프로필의 성별 + (여성인 경우) 외모/노출을 AI로 통합 분석
 * 하나의 API 호출로 모든 분석을 수행하여 토큰 효율성 극대화
 * 캐싱 지원: 이전에 분석한 계정은 캐시에서 조회
 */
export async function analyzeCombined(
    input: CombinedAnalysisInput
): Promise<CombinedAnalysisResponse> {
    const { profile, recentPosts, requestId } = input;

    // 1. 캐시 확인
    const cachedResult = await getCachedAnalysis(profile.username);
    if (cachedResult) {
        // 캐시 히트 로깅 (토큰 0으로 기록)
        await logTokenUsage(
            { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            'combined',
            requestId,
            true // cached_hit = true
        );
        return cachedResult;
    }

    console.log(`Cache MISS for ${profile.username}, calling Gemini API`);

    // 2. 이미지 수집 (프로필 + 최근 피드 최대 10장)
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

    // 3. 프롬프트 구성
    const prompt = COMBINED_ANALYSIS_PROMPT
        .replace('{profileImageDescription}', profile.profilePicUrl ? '첨부된 이미지 참조' : '없음')
        .replace('{username}', profile.username)
        .replace('{fullName}', profile.fullName || '없음')
        .replace('{bio}', profile.bio || '없음')
        .replace('{feedImagesDescription}', images.length > 1 ? '첨부된 이미지들 참조' : '없음');

    // 4. AI 분석 수행 (한 번의 호출로 모든 분석 + 재시도 로직 + 토큰 추적)
    const result = await analyzeWithGemini<CombinedAnalysisResponse>(prompt, images, {
        analysisType: 'combined',
        requestId,
    });

    // 5. genderConfidence가 임계값 미만이면 unknown 처리
    let finalResult: CombinedAnalysisResponse;
    if (result.genderConfidence < GENDER_CONFIDENCE_THRESHOLD) {
        finalResult = {
            gender: 'unknown',
            genderConfidence: result.genderConfidence,
            genderReasoning: result.genderReasoning,
        };
    } else {
        finalResult = result;
    }

    // 6. 결과 캐싱 (영구 저장)
    await setCachedAnalysis(profile.username, finalResult, profile.profilePicUrl);

    return finalResult;
}

/**
 * 여러 계정을 일괄 통합 분석 (캐싱 지원)
 */
export async function analyzeCombinedBatch(
    accounts: { profile: InstagramProfile; recentPosts: InstagramPost[] }[],
    batchSize: number = 5,
    requestId?: string
): Promise<Map<string, CombinedAnalysisResponse>> {
    const results = new Map<string, CombinedAnalysisResponse>();

    // 병렬 처리 (동시에 batchSize개씩)
    for (let i = 0; i < accounts.length; i += batchSize) {
        const batch = accounts.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (account) => {
                try {
                    const result = await analyzeCombined({
                        ...account,
                        requestId,
                    });
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

/**
 * 캐시 통계 조회
 */
export async function getCacheStats(): Promise<{
    totalCached: number;
    oldestEntry: string | null;
    newestEntry: string | null;
}> {
    const { count } = await supabaseAdmin
        .from('ai_analysis_cache')
        .select('*', { count: 'exact', head: true });

    const { data: oldest } = await supabaseAdmin
        .from('ai_analysis_cache')
        .select('created_at')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

    const { data: newest } = await supabaseAdmin
        .from('ai_analysis_cache')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    return {
        totalCached: count || 0,
        oldestEntry: oldest?.created_at || null,
        newestEntry: newest?.created_at || null,
    };
}
