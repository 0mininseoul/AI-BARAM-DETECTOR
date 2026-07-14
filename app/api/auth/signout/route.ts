import { createClient } from '@/lib/supabase/server';
import { appOriginForRequest } from '@/lib/constants/app-url';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const supabase = await createClient();
        await supabase.auth.signOut();

        return NextResponse.redirect(new URL('/', appOriginForRequest(request.url)), {
            status: 302,
        });
    } catch (error) {
        console.error('Sign out error:', error);
        return NextResponse.json({ error: 'Failed to sign out' }, { status: 500 });
    }
}
