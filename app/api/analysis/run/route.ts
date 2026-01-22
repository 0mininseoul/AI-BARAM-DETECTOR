import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import {
    getInstagramProfile,
    getFollowers,
    getFollowing,
    extractMutualFollows,
    getPosts,
    getPostComments,
} from '@/lib/services/instagram';
import { analyzeGenderBatch, analyzeAppearance, analyzeCommentIntimacyBatch } from '@/lib/services/ai';
import { calculateRiskScore, detectRecentSurge, calculateDurationMonths } from '@/lib/services/analysis/risk-score';
import { calculateConfidenceScore } from '@/lib/services/analysis/confidence-score';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';

// 분석 실행 API (내부용 - 직접 호출하지 않음)
export async function POST(request: Request) {
    try {
        const { requestId } = await request.json();

        if (!requestId) {
            return NextResponse.json({ error: 'requestId required' }, { status: 400 });
        }

        // 분석 요청 조회
        const { data: analysisRequest, error: fetchError } = await supabaseAdmin
            .from('analysis_requests')
            .select('*, users(email)')
            .eq('id', requestId)
            .single();

        if (fetchError || !analysisRequest) {
            return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        }

        // 이미 처리중이거나 완료된 경우
        if (analysisRequest.status !== 'pending') {
            return NextResponse.json({ error: 'Already processing or completed' }, { status: 400 });
        }

        // 상태 업데이트 함수
        const updateProgress = async (progress: number, step: string) => {
            await supabaseAdmin
                .from('analysis_requests')
                .update({ status: 'processing', progress, progress_step: step })
                .eq('id', requestId);
        };

        const targetId = analysisRequest.target_instagram_id;
        const targetGender = analysisRequest.target_gender;
        const oppositeGender = targetGender === 'male' ? 'female' : 'male';

        try {
            // Step 1: 프로필 수집 (0-10%)
            await updateProgress(5, '대상 계정 정보 수집 중...');
            const profile = await getInstagramProfile(targetId);

            if (!profile) {
                throw new Error('계정을 찾을 수 없습니다.');
            }

            if (profile.isPrivate) {
                throw new Error('비공개 계정은 분석할 수 없습니다.');
            }

            // Step 2: 팔로워/팔로잉 수집 (10-25%)
            await updateProgress(15, '팔로워/팔로잉 목록 수집 중...');
            const [followers, following] = await Promise.all([
                getFollowers(targetId, 500),
                getFollowing(targetId, 500),
            ]);

            // Step 3: 맞팔 추출 (25-30%)
            await updateProgress(28, '맞팔 계정 분석 중...');
            const mutualFollows = extractMutualFollows(followers, following);

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    total_followers: followers.length,
                    mutual_follows: mutualFollows.length,
                })
                .eq('id', requestId);

            // Step 4: 성별 판단 (30-50%)
            await updateProgress(35, '맞팔 계정 성별 판단 중...');

            // 맞팔 계정들의 프로필 및 게시물 수집
            const accountsWithPosts = await Promise.all(
                mutualFollows.slice(0, 50).map(async (account) => {
                    const accountProfile = await getInstagramProfile(account.username);
                    const posts = accountProfile && !accountProfile.isPrivate
                        ? await getPosts(account.username, 5)
                        : [];
                    return { profile: accountProfile || account as never, recentPosts: posts };
                })
            );

            const genderResults = await analyzeGenderBatch(
                accountsWithPosts.filter(a => a.profile) as { profile: never; recentPosts: never[] }[]
            );

            // 이성 계정 필터링
            const oppositeGenderAccounts = mutualFollows.filter((account) => {
                const result = genderResults.get(account.username);
                return result?.gender === oppositeGender && result.confidence >= 0.7;
            });

            await supabaseAdmin
                .from('analysis_requests')
                .update({ opposite_gender_count: oppositeGenderAccounts.length })
                .eq('id', requestId);

            // Step 5: 공개/비공개 분류 (50-55%)
            await updateProgress(52, '공개 계정 필터링 중...');
            const publicAccounts = oppositeGenderAccounts.filter((a) => !a.isPrivate);
            const privateAccounts = oppositeGenderAccounts.filter((a) => a.isPrivate);

            // 비공개 계정 저장
            if (privateAccounts.length > 0) {
                await supabaseAdmin.from('private_accounts').insert(
                    privateAccounts.map((account) => ({
                        request_id: requestId,
                        instagram_id: account.username,
                        profile_image: account.profilePicUrl,
                    }))
                );
            }

            // Step 6: 상호작용 수집 및 분석 (55-85%)
            await updateProgress(60, '상호작용 데이터 수집 중...');

            const results: {
                username: string;
                likesCount: number;
                normalCommentsCount: number;
                intimateCommentsCount: number;
                repliesCount: number;
                postTagsCount: number;
                captionMentionsCount: number;
                attractivenessLevel: 'high' | 'medium' | 'low' | null;
                firstInteractionDate?: string;
                recentInteractionDates: string[];
                profileImage?: string;
                genderConfidence?: number;
            }[] = [];

            // 대상 계정의 게시물 수집
            const targetPosts = await getPosts(targetId, 20);

            for (const suspect of publicAccounts.slice(0, 20)) {
                await updateProgress(
                    60 + Math.floor((results.length / Math.min(publicAccounts.length, 20)) * 20),
                    `${suspect.username} 분석 중...`
                );

                let likesCount = 0;
                let normalCommentsCount = 0;
                let intimateCommentsCount = 0;
                let repliesCount = 0;
                let postTagsCount = 0;
                let captionMentionsCount = 0;
                const interactionDates: string[] = [];

                // 용의자 게시물에서 대상의 상호작용 찾기
                const suspectPosts = await getPosts(suspect.username, 10);

                for (const post of suspectPosts) {
                    // 태그 확인
                    if (post.taggedUsers.includes(targetId)) {
                        postTagsCount++;
                    }
                    // 캡션 멘션 확인
                    if (post.mentionedUsers.includes(targetId)) {
                        captionMentionsCount++;
                    }

                    // 댓글 수집 및 분석
                    const comments = await getPostComments(
                        `https://instagram.com/p/${post.shortCode}`,
                        30
                    );

                    for (const comment of comments) {
                        if (comment.ownerUsername === targetId) {
                            interactionDates.push(comment.timestamp);

                            // 친밀도 분석
                            const intimacyResults = await analyzeCommentIntimacyBatch([
                                {
                                    authorId: targetId,
                                    postOwnerId: suspect.username,
                                    commentText: comment.text,
                                },
                            ]);

                            const intimacy = intimacyResults.get('0');
                            if (intimacy?.intimacyLevel === 'intimate') {
                                intimateCommentsCount++;
                            } else {
                                normalCommentsCount++;
                            }
                        }
                    }
                }

                // 대상 게시물에서 용의자의 상호작용 찾기
                for (const post of targetPosts) {
                    if (post.taggedUsers.includes(suspect.username)) {
                        postTagsCount++;
                    }
                    if (post.mentionedUsers.includes(suspect.username)) {
                        captionMentionsCount++;
                    }

                    const comments = await getPostComments(
                        `https://instagram.com/p/${post.shortCode}`,
                        30
                    );

                    for (const comment of comments) {
                        if (comment.ownerUsername === suspect.username) {
                            interactionDates.push(comment.timestamp);

                            const intimacyResults = await analyzeCommentIntimacyBatch([
                                {
                                    authorId: suspect.username,
                                    postOwnerId: targetId,
                                    commentText: comment.text,
                                },
                            ]);

                            const intimacy = intimacyResults.get('0');
                            if (intimacy?.intimacyLevel === 'intimate') {
                                intimateCommentsCount++;
                            } else {
                                normalCommentsCount++;
                            }
                        }
                    }
                }

                // 외모 분석
                let attractivenessLevel: 'high' | 'medium' | 'low' | null = null;
                if (suspectPosts.length > 0) {
                    const suspectProfile = await getInstagramProfile(suspect.username);
                    const appearanceResult = await analyzeAppearance(
                        suspectProfile?.profilePicUrl,
                        suspectPosts.map((p) => p.imageUrl).filter(Boolean) as string[]
                    );
                    if (appearanceResult.ownerIdentified) {
                        attractivenessLevel = appearanceResult.attractivenessLevel;
                    }
                }

                results.push({
                    username: suspect.username,
                    likesCount,
                    normalCommentsCount,
                    intimateCommentsCount,
                    repliesCount,
                    postTagsCount,
                    captionMentionsCount,
                    attractivenessLevel,
                    firstInteractionDate: interactionDates.sort()[0],
                    recentInteractionDates: interactionDates,
                    profileImage: suspect.profilePicUrl,
                    genderConfidence: genderResults.get(suspect.username)?.confidence,
                });
            }

            // Step 7: 점수 계산 및 순위 정렬 (85-95%)
            await updateProgress(88, '위험도 점수 계산 중...');

            const scoredResults = results.map((r) => {
                const durationMonths = calculateDurationMonths(r.firstInteractionDate);
                const { isRecentSurge, surgePercentage } = detectRecentSurge(
                    r.recentInteractionDates,
                    r.likesCount + r.normalCommentsCount + r.intimateCommentsCount
                );

                const score = calculateRiskScore({
                    likesCount: r.likesCount,
                    normalCommentsCount: r.normalCommentsCount,
                    intimateCommentsCount: r.intimateCommentsCount,
                    repliesCount: r.repliesCount,
                    postTagsCount: r.postTagsCount,
                    captionMentionsCount: r.captionMentionsCount,
                    attractivenessLevel: r.attractivenessLevel,
                    durationMonths,
                    isRecentSurge,
                });

                return {
                    ...r,
                    riskScore: score.finalScore,
                    durationMonths,
                    isRecentSurge,
                    surgePercentage,
                };
            });

            // 점수순 정렬
            scoredResults.sort((a, b) => b.riskScore - a.riskScore);

            // Step 8: 결과 저장 (95-100%)
            await updateProgress(95, '결과 저장 중...');

            // 상위 10명만 저장
            const topResults = scoredResults.slice(0, 10);

            for (let i = 0; i < topResults.length; i++) {
                const result = topResults[i];
                await supabaseAdmin.from('analysis_results').insert({
                    request_id: requestId,
                    rank: i + 1,
                    suspect_instagram_id: result.username,
                    suspect_profile_image: result.profileImage,
                    risk_score: result.riskScore,
                    likes_count: result.likesCount,
                    normal_comments_count: result.normalCommentsCount,
                    intimate_comments_count: result.intimateCommentsCount,
                    replies_count: result.repliesCount,
                    post_tags_count: result.postTagsCount,
                    caption_mentions_count: result.captionMentionsCount,
                    attractiveness_level: result.attractivenessLevel,
                    attractiveness_score:
                        result.attractivenessLevel === 'high'
                            ? 70
                            : result.attractivenessLevel === 'medium'
                                ? 10
                                : 0,
                    gender_confidence: result.genderConfidence,
                    first_interaction_date: result.firstInteractionDate,
                    duration_months: result.durationMonths,
                    is_recent_surge: result.isRecentSurge,
                    surge_percentage: result.surgePercentage,
                    is_unlocked: i === 0, // 1위만 무료 공개
                });
            }

            // 신뢰도 점수 계산
            const confidenceScore = calculateConfidenceScore({
                totalInteractions: scoredResults.reduce(
                    (sum, r) => sum + r.likesCount + r.normalCommentsCount + r.intimateCommentsCount,
                    0
                ),
                oppositeGenderCount: oppositeGenderAccounts.length,
                averagePostsPerAccount: targetPosts.length,
                genderConfidences: Array.from(genderResults.values())
                    .filter((r) => r.gender !== 'unknown')
                    .map((r) => r.confidence),
            });

            // 완료 상태 업데이트
            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'completed',
                    progress: 100,
                    progress_step: '분석 완료!',
                    confidence_score: confidenceScore,
                    completed_at: new Date().toISOString(),
                })
                .eq('id', requestId);

            // 이메일 알림 발송
            if (analysisRequest.users?.email) {
                await sendAnalysisCompleteEmail(
                    analysisRequest.users.email,
                    targetId,
                    requestId
                );
            }

            return NextResponse.json({ success: true, requestId });
        } catch (pipelineError) {
            // 실패 상태 업데이트
            const errorMessage = pipelineError instanceof Error ? pipelineError.message : 'Unknown error';

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'failed',
                    error_message: errorMessage,
                })
                .eq('id', requestId);

            throw pipelineError;
        }
    } catch (error) {
        console.error('Analysis pipeline error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Pipeline failed' },
            { status: 500 }
        );
    }
}
