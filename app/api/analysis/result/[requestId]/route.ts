import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
) {
    try {
        const { requestId } = await params;
        const supabase = await createClient();

        // 1. 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        // 2. 분석 요청 조회
        const { data: analysisRequest, error: requestError } = await supabase
            .from('analysis_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        // 3. 분석이 완료되지 않은 경우
        if (analysisRequest.status !== 'completed') {
            return NextResponse.json(
                {
                    error: '분석이 아직 완료되지 않았습니다.',
                    status: analysisRequest.status,
                    progress: analysisRequest.progress,
                },
                { status: 400 }
            );
        }

        // 4. 분석 결과 조회
        const { data: results, error: resultsError } = await supabase
            .from('analysis_results')
            .select('*')
            .eq('request_id', requestId)
            .order('rank', { ascending: true });

        if (resultsError) {
            console.error('Results fetch error:', resultsError);
            return NextResponse.json(
                { error: '결과 조회에 실패했습니다.' },
                { status: 500 }
            );
        }

        // 5. 비공개 계정 조회
        const { data: privateAccounts } = await supabase
            .from('private_accounts')
            .select('instagram_id, profile_image')
            .eq('request_id', requestId);

        // 6. 1위 결과 (무료 공개)
        const topResult = results && results.length > 0 ? results[0] : null;

        // 7. 2위 이하 결과 (잠금 처리)
        const lockedResults = results
            ?.slice(1)
            .map((result) => ({
                rank: result.rank,
                riskScore: result.risk_score,
                isUnlocked: result.is_unlocked,
                unlockPrice: 499, // $4.99 in cents
            })) || [];

        // 8. ID 마스킹 처리
        const maskInstagramId = (id: string): string => {
            if (id.length <= 3) return id[0] + '***';
            const visiblePart = id.slice(0, 2);
            const hiddenPart = '***';
            const endPart = id.slice(-1);
            return `${visiblePart}${hiddenPart}_${endPart}`;
        };

        // 9. 응답 구성
        return NextResponse.json({
            requestId,
            status: analysisRequest.status,
            summary: {
                targetInstagramId: analysisRequest.target_instagram_id,
                totalFollowers: analysisRequest.total_followers || 0,
                mutualFollows: analysisRequest.mutual_follows || 0,
                oppositeGenderCount: analysisRequest.opposite_gender_count || 0,
                privateAccountsCount: privateAccounts?.length || 0,
                confidenceScore: analysisRequest.confidence_score || 0,
            },
            topResult: topResult
                ? {
                    rank: topResult.rank,
                    instagramId: maskInstagramId(topResult.suspect_instagram_id),
                    profileImage: topResult.suspect_profile_image, // TODO: blur 처리
                    riskScore: topResult.risk_score,
                    interactions: {
                        likes: topResult.likes_count,
                        normalComments: topResult.normal_comments_count,
                        intimateComments: topResult.intimate_comments_count,
                        replies: topResult.replies_count,
                        postTags: topResult.post_tags_count,
                        captionMentions: topResult.caption_mentions_count,
                    },
                    attractivenessLevel: topResult.attractiveness_level,
                    durationMonths: topResult.duration_months,
                    isRecentSurge: topResult.is_recent_surge,
                    surgePercentage: topResult.surge_percentage,
                }
                : null,
            lockedResults,
            privateAccounts:
                privateAccounts?.map((account) => ({
                    instagramId: maskInstagramId(account.instagram_id),
                    profileImage: account.profile_image,
                })) || [],
        });
    } catch (error) {
        console.error('Result fetch error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
