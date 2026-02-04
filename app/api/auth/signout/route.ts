import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

const LANDING_PAGE_URL = 'https://ai-yeosachinscanner.vercel.app';

export async function POST() {
    try {
        const supabase = await createClient();
        await supabase.auth.signOut();

        return NextResponse.redirect(new URL('/', LANDING_PAGE_URL), {
            status: 302,
        });
    } catch (error) {
        console.error('Sign out error:', error);
        return NextResponse.json({ error: 'Failed to sign out' }, { status: 500 });
    }
}
