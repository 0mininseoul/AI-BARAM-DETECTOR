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
            .select('*')
            .eq('id', requestId)
            .single();

        if (error || !analysisRequest) {
            return NextResponse.json(
                { error: '분석 요청을 찾을 수 없습니다.' },
                { status: 404 }
            );
        }

        // 3. 예상 완료 시간 계산 (시작 후 약 5분)
        let estimatedCompletionTime: string | null = null;
        if (analysisRequest.status === 'processing') {
            const createdAt = new Date(analysisRequest.created_at);
            const estimatedCompletion = new Date(createdAt.getTime() + 5 * 60 * 1000);
            estimatedCompletionTime = estimatedCompletion.toISOString();
        }

        return NextResponse.json({
            requestId: analysisRequest.id,
            status: analysisRequest.status,
            progress: analysisRequest.progress,
            progressStep: analysisRequest.progress_step,
            createdAt: analysisRequest.created_at,
            completedAt: analysisRequest.completed_at,
            estimatedCompletionTime,
        });
    } catch (error) {
        console.error('Status check error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
