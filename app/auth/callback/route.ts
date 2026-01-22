import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const next = searchParams.get('next') ?? '/analyze';

    // 1. 리다이렉트 될 Response 객체를 미리 생성
    const forwardedHost = request.headers.get('x-forwarded-host');
    const baseUrl = forwardedHost ? `https://${forwardedHost}` : origin;
    const redirectUrl = new URL(next, baseUrl);
    redirectUrl.searchParams.set('verified', 'true'); // 디버깅용 플래그

    const response = NextResponse.redirect(redirectUrl);

    if (code) {
        const cookieStore = await cookies();

        // 2. 이 핸들러 전용 Supabase 클라이언트 생성 (Response 객체에 쿠키를 심기 위해)
        const supabase = createServerClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                cookies: {
                    getAll() {
                        return cookieStore.getAll();
                    },
                    setAll(cookiesToSet) {
                        try {
                            cookiesToSet.forEach(({ name, value, options }) => {
                                // Next.js CookieStore에 설정
                                cookieStore.set(name, value, options);
                                // Response 객체에도 직접 설정 (중요: 이것이 누락된 쿠키 문제를 해결함)
                                response.cookies.set(name, value, options);
                            });
                        } catch (error) {
                            console.error('Error setting cookies in callback:', error);
                        }
                    },
                },
            }
        );

        // 3. 코드 교환 실행
        const { error } = await supabase.auth.exchangeCodeForSession(code);

        if (error) {
            console.error('Auth callback error:', error);
            return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
        }

        // 디버깅: 로그
        console.log('Auth callback: Session exchanged successfully. Cookies set to response.');
    } else {
        return NextResponse.redirect(`${origin}/login?error=no_code`);
    }

    // 4. 쿠키가 심어진 Response 반환
    return response;
}
