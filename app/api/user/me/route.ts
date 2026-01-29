import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const supabase = await createClient();

        // 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        // Admin 클라이언트로 사용자 정보 조회 (RLS 우회)
        const { data: dbUser, error: dbError } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        if (dbError || !dbUser) {
            // 사용자 레코드가 없으면 생성
            const { data: newUser, error: createError } = await supabaseAdmin
                .from('users')
                .insert({
                    id: user.id,
                    email: user.email!,
                    provider: user.app_metadata.provider || 'google',
                    analysis_count: 0,
                    is_paid_user: false,
                    is_unlimited: false,
                })
                .select()
                .single();

            if (createError) {
                console.error('User creation error:', createError);
                return NextResponse.json(
                    { error: '사용자 정보 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }

            return NextResponse.json({ user: newUser });
        }

        return NextResponse.json({ user: dbUser });
    } catch (error) {
        console.error('User fetch error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
