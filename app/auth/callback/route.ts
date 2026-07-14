import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const appOrigin = appOriginForRequest(request.url);

    if (!code) {
        console.error('Auth callback: No code provided');
        return NextResponse.redirect(new URL('/login?error=no_code', appOrigin));
    }

    const cookieStore = await cookies();

    // Supabase 클라이언트 생성 - cookieStore.set() 사용 (Next.js 네이티브 방식)
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
                        cookieStore.set(name, value, options);
                    });
                },
            },
        }
    );

    // 코드 교환 실행
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        console.error('Auth callback error:', error);
        const loginUrl = new URL('/login', appOrigin);
        loginUrl.searchParams.set('error', error.message);
        return NextResponse.redirect(loginUrl);
    }

    // 세션 검증을 통해 쿠키 설정 강제 (setAll 트리거)
    await supabase.auth.getUser();

    const redirectUrl = appRedirectUrlForRequest(request.url, searchParams.get('next'));
    redirectUrl.searchParams.set('verified', 'true');

    return NextResponse.redirect(redirectUrl);
}
