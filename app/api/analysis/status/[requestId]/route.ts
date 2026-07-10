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

        // 2. 분석 요청 조회 (RLS로 본인 데이터만 조회됨)
        const { data: analysisRequest, error } = await supabase
            .from('analysis_requests')
            .select('id, status, progress, progress_step, background_processing, created_at, completed_at')
            .eq('id', requestId)
            .single();

        if (error || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        return NextResponse.json({
            requestId: analysisRequest.id,
            status: analysisRequest.status,
            progress: analysisRequest.progress,
            progressStep: analysisRequest.progress_step,
            backgroundProcessing: analysisRequest.background_processing === true,
            createdAt: analysisRequest.created_at,
            completedAt: analysisRequest.completed_at,
            // Keep the response field stable until a telemetry-based estimate is available.
            estimatedCompletionTime: null,
        });
    } catch (error) {
        console.error('Status check error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
