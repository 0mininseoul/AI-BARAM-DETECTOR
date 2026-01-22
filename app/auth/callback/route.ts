import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const next = searchParams.get('next') ?? '/analyze';

    // 리다이렉트 URL 계산
    const forwardedHost = request.headers.get('x-forwarded-host');
    const baseUrl = forwardedHost ? `https://${forwardedHost}` : origin;

    if (!code) {
        console.error('Auth callback: No code provided');
        return NextResponse.redirect(`${baseUrl}/login?error=no_code`);
    }

    const redirectUrl = new URL(next, baseUrl);
    redirectUrl.searchParams.set('verified', 'true');

    // 리다이렉트 응답을 먼저 생성 (쿠키를 이 응답에 설정하기 위해)
    const response = NextResponse.redirect(redirectUrl);

    const cookieStore = await cookies();

    // Supabase 클라이언트 생성 - 쿠키는 response.cookies에만 설정
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        // 리다이렉트 응답에 쿠키 설정 (Set-Cookie 헤더로 전달됨)
                        response.cookies.set(name, value, options);
                    });
                    console.log('Auth callback: Cookies set:', cookiesToSet.map(c => c.name).join(', '));
                },
            },
        }
    );

    // 코드 교환 실행
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        console.error('Auth callback error:', error);
        return NextResponse.redirect(`${baseUrl}/login?error=${encodeURIComponent(error.message)}`);
    }

    console.log('Auth callback: Session exchanged successfully, redirecting to:', redirectUrl.toString());

    return response;
}
