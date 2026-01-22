import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const next = searchParams.get('next') ?? '/analyze';

    if (code) {
        const supabase = await createClient();
        const { error } = await supabase.auth.exchangeCodeForSession(code);

        if (error) {
            console.error('Auth callback error:', error);
            return redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
        }

        // 디버깅: 세션 생성 확인
        const { data: { session: debugSession } } = await supabase.auth.getSession();
        console.log('Auth callback success. Session user:', debugSession?.user?.id);

        // 세션 교환 성공
        const forwardedHost = request.headers.get('x-forwarded-host'); // original origin before load balancer

        let redirectTo = next;
        if (forwardedHost) {
            redirectTo = `https://${forwardedHost}${next}`;
        } else {
            redirectTo = `${origin}${next}`;
        }

        // next/navigation의 redirect 함수 사용 -> Set-Cookie 헤더 보존
        return redirect(redirectTo);
    }

    // code가 없는 경우
    return redirect(`${origin}/login?error=no_code`);
}
