import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        if (!token || token.length !== 64) {
            return NextResponse.json(
                { error: '유효하지 않은 공유 링크입니다.' },
                { status: 400 }
            );
        }

        // 1. 토큰으로 분석 요청 조회 (인증 불필요, admin 사용)
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select('*')
            .eq('share_token', token)
            .eq('share_enabled', true)
            .single();

        if (requestError || !analysisRequest) {
            return NextResponse.json(
                { error: '공유 링크를 찾을 수 없거나 비활성화되었습니다.' },
                { status: 404 }
            );
        }

        // 2. 분석이 완료되지 않은 경우
        if (analysisRequest.status !== 'completed') {
            return NextResponse.json(
                { error: '분석이 아직 완료되지 않았습니다.' },
                { status: 400 }
            );
        }

        const requestId = analysisRequest.id;

        // 3. 분석 결과 조회 (여성 계정들)
        const { data: results, error: resultsError } = await supabaseAdmin
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

        // 4. 비공개 계정 조회
        const { data: privateAccounts } = await supabaseAdmin
            .from('private_accounts')
            .select('instagram_id, profile_image, full_name')
            .eq('request_id', requestId);

        // 5. 성별 비율 계산
        const genderStats = analysisRequest.gender_stats || { male: 0, female: 0, unknown: 0 };
        const totalGender = genderStats.male + genderStats.female + genderStats.unknown;
        const genderRatio = {
            male: {
                count: genderStats.male,
                percentage: totalGender > 0 ? Math.round((genderStats.male / totalGender) * 100) : 0,
            },
            female: {
                count: genderStats.female,
                percentage: totalGender > 0 ? Math.round((genderStats.female / totalGender) * 100) : 0,
            },
            unknown: {
                count: genderStats.unknown,
                percentage: totalGender > 0 ? Math.round((genderStats.unknown / totalGender) * 100) : 0,
            },
        };

        // 6. 여성 계정 목록
        const femaleAccounts = results?.map((result) => ({
            instagramId: result.suspect_instagram_id,
            fullName: result.suspect_full_name,
            profileImage: result.suspect_profile_image,
            instagramUrl: `https://instagram.com/${result.suspect_instagram_id}`,
            riskGrade: result.risk_grade as 'high_risk' | 'caution' | 'normal',
            bio: result.bio || '',
        })) || [];

        // 7. 비공개 계정 목록
        const privateAccountsList = privateAccounts?.map((account) => ({
            instagramId: account.instagram_id,
            fullName: account.full_name,
            profileImage: account.profile_image,
            instagramUrl: `https://instagram.com/${account.instagram_id}`,
        })) || [];

        // 8. 응답 구성 (공유 페이지용)
        return NextResponse.json({
            requestId,
            status: analysisRequest.status,
            isShared: true, // 공유 링크로 접근했음을 표시
            summary: {
                targetInstagramId: analysisRequest.target_instagram_id,
                mutualFollows: analysisRequest.mutual_follows || 0,
                genderRatio,
            },
            femaleAccounts,
            privateAccounts: privateAccountsList,
        });
    } catch (error) {
        console.error('Share result fetch error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
