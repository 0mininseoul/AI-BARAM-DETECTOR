import { createClient } from '@supabase/supabase-js';

// Admin 클라이언트 - Service Role Key 사용 (서버 사이드 전용)
export const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    }
);
