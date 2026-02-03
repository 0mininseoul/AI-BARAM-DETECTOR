import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST() {
    try {
        const supabase = await createClient();
        await supabase.auth.signOut();

        return NextResponse.redirect(new URL('/', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'), {
            status: 302,
        });
    } catch (error) {
        console.error('Sign out error:', error);
        return NextResponse.json({ error: 'Failed to sign out' }, { status: 500 });
    }
}
