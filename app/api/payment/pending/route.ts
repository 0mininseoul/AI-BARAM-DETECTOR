import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// pending_analysis 생성 API
export async function POST(request: Request) {
    try {
        const supabase = await createClient();

        // 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        const { planType, targetInstagramId, targetGender } = await request.json();

        if (!planType || !targetInstagramId || !targetGender) {
            return NextResponse.json(
                { error: '필수 정보가 누락되었습니다.' },
                { status: 400 }
            );
        }

        if (!['basic', 'standard'].includes(planType)) {
            return NextResponse.json(
                { error: '유효하지 않은 요금제입니다.' },
                { status: 400 }
            );
        }

        // 분석 대기 요청 생성
        const { data: pendingAnalysis, error: pendingError } = await supabase
            .from('pending_analysis')
            .insert({
                user_id: user.id,
                target_instagram_id: targetInstagramId,
                target_gender: targetGender,
                plan_type: planType,
                status: 'awaiting_payment',
            })
            .select()
            .single();

        if (pendingError) {
            console.error('Pending analysis creation failed:', pendingError);
            return NextResponse.json(
                { error: '요청 생성에 실패했습니다.' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            pendingId: pendingAnalysis.id,
        });
    } catch (error) {
        console.error('Pending creation error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
