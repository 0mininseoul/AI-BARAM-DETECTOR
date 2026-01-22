import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const next = searchParams.get('next') ?? '/analyze';

    if (code) {
        const supabase = await createClient();
        const { error } = await supabase.auth.exchangeCodeForSession(code);

        if (error) {
            console.error('Auth callback error:', error);
            return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
        }

        // 세션 교환 성공
        const forwardedHost = request.headers.get('x-forwarded-host'); // original origin before load balancer
        const isLocalEnv = process.env.NODE_ENV === 'development';

        let redirectTo = next;
        if (forwardedHost) {
            redirectTo = `https://${forwardedHost}${next}`;
        } else {
            redirectTo = `${origin}${next}`;
        }

        // 쿠키가 확실히 설정되도록 응답 헤더 확인 (디버깅용)
        const response = NextResponse.redirect(redirectTo);

        // 개발 환경에서 리다이렉트 루프 방지 (옵션)
        if (isLocalEnv) {
            console.log('Redirecting to:', redirectTo);
        }

        return response;
    }

    // code가 없는 경우
    console.error('Auth callback missing code');
    return NextResponse.redirect(`${origin}/login?error=no_code`);
}
