import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
    const cookieStore = await cookies();

    return createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        );
                    } catch (error) {
                        // Server Component에서 호출된 경우 무시되지만, 디버깅을 위해 로그 출력
                        if (process.env.NODE_ENV === 'development' || (error as Error).message !== 'The "cookies" helper can only be used in a server action or route handler.') {
                            console.error('Error setting cookies:', error);
                        }
                    }
                },
            },
        }
    );
}
