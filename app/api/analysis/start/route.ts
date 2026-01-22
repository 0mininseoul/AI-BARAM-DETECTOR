import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';

// 무료 분석 횟수 제한
const FREE_ANALYSIS_LIMIT = 1;

export async function POST(request: Request) {
    try {
        const supabase = await createClient();

        // 1. 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        // 2. 요청 바디 파싱
        const body = await request.json();
        const { targetInstagramId, targetGender } = body;

        // 3. 입력값 검증
        if (!targetInstagramId || !targetGender) {
            return NextResponse.json(
                { error: '인스타그램 아이디와 성별을 입력해주세요.' },
                { status: 400 }
            );
        }

        if (!['male', 'female'].includes(targetGender)) {
            return NextResponse.json(
                { error: '성별은 male 또는 female만 가능합니다.' },
                { status: 400 }
            );
        }

        // 인스타그램 ID 형식 검증 (@ 제거, 영문/숫자/밑줄/점만 허용)
        const cleanedId = targetInstagramId.replace(/^@/, '').toLowerCase();
        if (!/^[a-z0-9._]+$/.test(cleanedId)) {
            return NextResponse.json(
                { error: '올바른 인스타그램 아이디를 입력해주세요.' },
                { status: 400 }
            );
        }

        // 4. 사용자 정보 조회 (없으면 생성)
        let { data: dbUser } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        if (!dbUser) {
            // 새 사용자 생성
            const { data: newUser, error: createError } = await supabaseAdmin
                .from('users')
                .insert({
                    id: user.id,
                    email: user.email!,
                    provider: user.app_metadata.provider || 'google',
                    analysis_count: 0,
                    is_paid_user: false,
                })
                .select()
                .single();

            if (createError) {
                console.error('User creation error:', createError);
                return NextResponse.json(
                    { error: '사용자 정보 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }
            dbUser = newUser;
        }

        // 5. 무료 분석 횟수 체크
        if (!dbUser.is_paid_user && dbUser.analysis_count >= FREE_ANALYSIS_LIMIT) {
            return NextResponse.json(
                { error: '무료 분석 횟수를 모두 사용했습니다.', code: 'LIMIT_EXCEEDED' },
                { status: 403 }
            );
        }

        // 6. 분석 요청 생성
        const { data: analysisRequest, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .insert({
                user_id: user.id,
                target_instagram_id: cleanedId,
                target_gender: targetGender,
                status: 'pending',
                progress: 0,
                progress_step: '분석 대기 중...',
            })
            .select()
            .single();

        if (requestError) {
            console.error('Analysis request creation error:', requestError);
            return NextResponse.json(
                { error: '분석 요청 생성에 실패했습니다.' },
                { status: 500 }
            );
        }

        // 7. 사용자 분석 횟수 증가
        await supabaseAdmin
            .from('users')
            .update({ analysis_count: dbUser.analysis_count + 1 })
            .eq('id', user.id);

        // 8. 백그라운드 분석 작업 트리거
        // 비동기로 파이프라인 실행 (응답을 기다리지 않음)
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        fetch(`${appUrl}/api/analysis/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: analysisRequest.id }),
        }).catch((err) => {
            console.error('Failed to trigger analysis pipeline:', err);
        });

        return NextResponse.json(
            {
                success: true,
                requestId: analysisRequest.id,
                message: '분석이 시작되었습니다.',
            },
            { status: 201 }
        );
    } catch (error) {
        console.error('Analysis start error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
