import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const next = searchParams.get('next') ?? '/analyze';

    // 1. 리다이렉트 URL 계산
    const forwardedHost = request.headers.get('x-forwarded-host');
    const baseUrl = forwardedHost ? `https://${forwardedHost}` : origin;

    const redirectUrl = new URL(next, baseUrl);
    redirectUrl.searchParams.set('verified', 'true');

    // 2. HTML 응답 생성 (클라이언트 사이드 리다이렉트) - 쿠키 저장 보장용 필살기
    // 서버 리다이렉트(302/307)는 브라우저/네트워크 환경에 따라 쿠키 처리가 불안정할 수 있음
    const encodedRedirectUrl = redirectUrl.toString().replace(/"/g, '&quot;');
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="0;url=${encodedRedirectUrl}">
        <title>Redirecting...</title>
    </head>
    <body>
        <p>로그인 성공! 잠시만 기다려주세요...</p>
        <script>
            window.location.href = "${encodedRedirectUrl}";
        </script>
    </body>
    </html>
    `;

    const response = new NextResponse(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
        },
    });

    if (code) {
        const cookieStore = await cookies();

        // 3. Supabase 클라이언트 생성 및 쿠키 설정
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
                                // Response 객체에도 직접 설정 (HTML 응답과 함께 전달됨)
                                response.cookies.set(name, value, options);
                            });
                        } catch (error) {
                            console.error('Error setting cookies in callback:', error);
                        }
                    },
                },
            }
        );

        // 4. 코드 교환 실행
        const { error } = await supabase.auth.exchangeCodeForSession(code);

        if (error) {
            console.error('Auth callback error:', error);
            return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
        }

        console.log('Auth callback: Session exchanged. Returning HTML for client-side redirect.');
    } else {
        return NextResponse.redirect(`${origin}/login?error=no_code`);
    }

    // 5. HTML 응답 반환
    return response;
}
