import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';

// 결제 성공 콜백
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const pendingId = searchParams.get('pending_id');

        if (!pendingId) {
            return NextResponse.redirect(new URL('/analyze?error=missing_id', request.url));
        }

        // 대기 중인 분석 요청 조회
        const { data: pending, error: fetchError } = await supabaseAdmin
            .from('pending_analysis')
            .select('*')
            .eq('id', pendingId)
            .single();

        if (fetchError || !pending) {
            return NextResponse.redirect(new URL('/analyze?error=not_found', request.url));
        }

        if (pending.status === 'paid') {
            // 이미 처리됨 - 분석 페이지로 리다이렉트
            const { data: existingRequest } = await supabaseAdmin
                .from('analysis_requests')
                .select('id')
                .eq('user_id', pending.user_id)
                .eq('target_instagram_id', pending.target_instagram_id)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (existingRequest) {
                return NextResponse.redirect(new URL(`/progress/${existingRequest.id}`, request.url));
            }
        }

        // 결제 완료 처리
        await supabaseAdmin
            .from('pending_analysis')
            .update({ status: 'paid' })
            .eq('id', pendingId);

        // 분석 요청 생성
        const { data: analysisRequest, error: createError } = await supabaseAdmin
            .from('analysis_requests')
            .insert({
                user_id: pending.user_id,
                target_instagram_id: pending.target_instagram_id,
                target_gender: pending.target_gender,
                plan_type: pending.plan_type,
                status: 'pending',
                progress: 0,
                progress_step: '분석 대기 중...',
            })
            .select()
            .single();

        if (createError || !analysisRequest) {
            console.error('Analysis request creation failed:', createError);
            return NextResponse.redirect(new URL('/analyze?error=create_failed', request.url));
        }

        // 분석 시작 (비동기)
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        fetch(`${baseUrl}/api/analysis/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: analysisRequest.id }),
        }).catch(console.error);

        // 진행 페이지로 리다이렉트
        return NextResponse.redirect(new URL(`/progress/${analysisRequest.id}`, request.url));
    } catch (error) {
        console.error('Payment success handler error:', error);
        return NextResponse.redirect(new URL('/analyze?error=unknown', request.url));
    }
}
