import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    createServerClient: vi.fn(),
    createClient: vi.fn(),
    exchangeCodeForSession: vi.fn(),
    getCallbackUser: vi.fn(),
    getMeUser: vi.fn(),
    fetch: vi.fn(),
    from: vi.fn(),
    upsert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: routeMocks.cookies }));
vi.mock('@supabase/ssr', () => ({
    createServerClient: routeMocks.createServerClient,
}));
vi.mock('@/lib/supabase/server', () => ({
    createClient: routeMocks.createClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: routeMocks.from },
}));

import {
    buildAuthProfilePatch,
    type AuthProfileSource,
} from './auth-profile';
import { GET as authCallback } from '@/app/auth/callback/route';
import { GET as getCurrentUser } from '@/app/api/user/me/route';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';

function installCallbackSession(
    provider: 'kakao' | 'google',
    providerToken: string
) {
    routeMocks.exchangeCodeForSession.mockResolvedValue({
        data: {
            session: { provider_token: providerToken },
            user: {
                id: USER_ID,
                email: 'user@example.com',
                app_metadata: { provider },
            },
        },
        error: null,
    });
    routeMocks.getCallbackUser.mockResolvedValue({
        data: { user: { id: USER_ID } },
        error: null,
    });
    routeMocks.createServerClient.mockReturnValue({
        auth: {
            exchangeCodeForSession: routeMocks.exchangeCodeForSession,
            getUser: routeMocks.getCallbackUser,
        },
    });
}

function installCallbackProfileFetch() {
    routeMocks.fetch.mockImplementation(async () => new Response(JSON.stringify({
        kakao_account: {
            name: '  Account Name  ',
            gender: '  female  ',
            birthyear: 1997,
            phone_number: '  +82 10-1234-5678  ',
            profile: {
                nickname: '  Kakao Nickname  ',
                profile_image_url: '  https://example.com/kakao.jpg  ',
            },
        },
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    }));
}

function callbackRequest(code: string) {
    return new Request(
        `http://localhost:3000/auth/callback?code=${code}&next=%2Fanalyze`
    );
}

describe('OAuth callback profile persistence', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubGlobal('fetch', routeMocks.fetch);
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
        routeMocks.cookies.mockResolvedValue({
            getAll: vi.fn(() => []),
            set: vi.fn(),
        });
        routeMocks.from.mockImplementation((table: string) => {
            if (table !== 'users') throw new Error(`unexpected table: ${table}`);
            return { upsert: routeMocks.upsert };
        });
        routeMocks.upsert.mockResolvedValue({ error: null });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('upserts the current helper-derived Kakao profile on every login', async () => {
        const providerToken = 'kakao-provider-token';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('kakao', providerToken);
        installCallbackProfileFetch();

        await authCallback(callbackRequest('first-code'));
        await authCallback(callbackRequest('second-code'));

        const expectedProfile = {
            id: USER_ID,
            email: 'user@example.com',
            provider: 'kakao',
            name: 'Account Name',
            nickname: 'Kakao Nickname',
            profile_image: 'https://example.com/kakao.jpg',
            gender: 'female',
            birthyear: '1997',
            phone_number: '+82 10-1234-5678',
            phone_number_normalized: '+821012345678',
        };
        expect(routeMocks.exchangeCodeForSession).toHaveBeenNthCalledWith(1, 'first-code');
        expect(routeMocks.exchangeCodeForSession).toHaveBeenNthCalledWith(2, 'second-code');
        expect(routeMocks.fetch).toHaveBeenCalledTimes(2);
        expect(routeMocks.fetch).toHaveBeenNthCalledWith(
            1,
            'https://kapi.kakao.com/v2/user/me',
            {
                headers: { Authorization: `Bearer ${providerToken}` },
                cache: 'no-store',
            }
        );
        expect(routeMocks.upsert).toHaveBeenNthCalledWith(
            1,
            expectedProfile,
            { onConflict: 'id' }
        );
        expect(routeMocks.upsert).toHaveBeenNthCalledWith(
            2,
            expectedProfile,
            { onConflict: 'id' }
        );
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('keeps Google callback exchange and redirect behavior without Kakao work', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('google', 'google-provider-token');

        const response = await authCallback(callbackRequest('google-code'));

        expect(response.headers.get('location')).toBe(
            'http://localhost:3000/analyze?verified=true'
        );
        expect(routeMocks.exchangeCodeForSession).toHaveBeenCalledWith('google-code');
        expect(routeMocks.getCallbackUser).toHaveBeenCalledOnce();
        expect(routeMocks.fetch).not.toHaveBeenCalled();
        expect(routeMocks.from).not.toHaveBeenCalled();
        expect(routeMocks.upsert).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs only a non-PII code when the Kakao profile upsert fails', async () => {
        const providerToken = 'private-provider-token';
        const rawPhone = '+82 10-1234-5678';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('kakao', providerToken);
        installCallbackProfileFetch();
        routeMocks.upsert.mockResolvedValue({
            error: {
                code: '23505',
                message: `duplicate ${rawPhone} for Kakao Nickname using ${providerToken}`,
            },
        });

        await authCallback(callbackRequest('error-code'));

        expect(errorSpy).toHaveBeenCalledWith(
            'users upsert (kakao profile) failed:',
            '23505'
        );
        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).not.toContain(providerToken);
        expect(logged).not.toContain(rawPhone);
        expect(logged).not.toContain('Kakao Nickname');
    });

    it('does not log a thrown Kakao response error containing token or profile PII', async () => {
        const providerToken = 'private-provider-token';
        const rawPhone = '+82 10-1234-5678';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        installCallbackSession('kakao', providerToken);
        routeMocks.fetch.mockRejectedValue(new Error(
            `failed for ${rawPhone}, Kakao Nickname, ${providerToken}`
        ));

        await authCallback(callbackRequest('fetch-error-code'));

        expect(errorSpy).toHaveBeenCalledWith('Kakao profile sync failed');
        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).not.toContain(providerToken);
        expect(logged).not.toContain(rawPhone);
        expect(logged).not.toContain('Kakao Nickname');
    });
});

function installAuthenticatedUser(user: Record<string, unknown>) {
    routeMocks.getMeUser.mockResolvedValue({
        data: { user },
        error: null,
    });
    routeMocks.createClient.mockResolvedValue({
        auth: { getUser: routeMocks.getMeUser },
    });
}

function installUserAdminResults(
    ...results: Array<{ data: unknown; error: unknown }>
) {
    const query = {
        select: routeMocks.select,
        eq: routeMocks.eq,
        single: routeMocks.single,
        insert: routeMocks.insert,
        update: routeMocks.update,
    };
    routeMocks.select.mockReturnValue(query);
    routeMocks.eq.mockReturnValue(query);
    routeMocks.insert.mockReturnValue(query);
    routeMocks.update.mockReturnValue(query);
    for (const result of results) {
        routeMocks.single.mockResolvedValueOnce(result);
    }
    routeMocks.from.mockImplementation((table: string) => {
        if (table !== 'users') throw new Error(`unexpected table: ${table}`);
        return query;
    });
}

describe('/api/user/me profile persistence', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('inserts the helper-derived social profile with gender and normalized phone', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: undefined,
            app_metadata: { provider: 'kakao' },
            user_metadata: {
                full_name: '  Full Name  ',
                preferred_username: '  Preferred Nick  ',
                avatar_url: '  https://example.com/social.jpg  ',
                phone_number: '  010-9876-5432  ',
                gender: '  female  ',
                birth_year: 1994,
            },
        });
        const createdUser = { id: USER_ID, created: true };
        installUserAdminResults(
            { data: null, error: { code: 'PGRST116' } },
            { data: createdUser, error: null }
        );

        const response = await getCurrentUser();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ user: createdUser });
        expect(routeMocks.insert).toHaveBeenCalledWith({
            id: USER_ID,
            email: 'user@example.com',
            provider: 'kakao',
            analysis_count: 0,
            is_paid_user: false,
            is_unlimited: false,
            name: 'Full Name',
            nickname: 'Preferred Nick',
            profile_image: 'https://example.com/social.jpg',
            phone_number: '010-9876-5432',
            phone_number_normalized: '+821098765432',
            gender: 'female',
            birthyear: '1994',
        });
        expect(routeMocks.update).not.toHaveBeenCalled();
    });

    it('backfills missing helper fields without replacing existing profile values', async () => {
        installAuthenticatedUser({
            id: USER_ID,
            email: 'user@example.com',
            phone: '  010-1111-2222  ',
            app_metadata: { provider: 'kakao' },
            user_metadata: {
                name: '  Replacement Name  ',
                nickname: '  Updated Nick  ',
                profile_image: '  https://example.com/backfill.jpg  ',
                gender: '  male  ',
                birthyear: '  1996  ',
            },
        });
        const existingUser = {
            id: USER_ID,
            name: 'Existing Name',
            nickname: null,
            profile_image: null,
            phone_number: null,
            phone_number_normalized: null,
            gender: null,
            birthyear: null,
        };
        const updatedUser = {
            ...existingUser,
            nickname: 'Updated Nick',
            profile_image: 'https://example.com/backfill.jpg',
            phone_number: '010-1111-2222',
            phone_number_normalized: '+821011112222',
            gender: 'male',
            birthyear: '1996',
        };
        installUserAdminResults(
            { data: existingUser, error: null },
            { data: updatedUser, error: null }
        );

        const response = await getCurrentUser();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ user: updatedUser });
        expect(routeMocks.update).toHaveBeenCalledWith({
            nickname: 'Updated Nick',
            profile_image: 'https://example.com/backfill.jpg',
            phone_number: '010-1111-2222',
            phone_number_normalized: '+821011112222',
            gender: 'male',
            birthyear: '1996',
        });
        expect(routeMocks.update).not.toHaveBeenCalledWith(
            expect.objectContaining({ name: expect.anything() })
        );
        expect(routeMocks.insert).not.toHaveBeenCalled();
    });
});

describe('buildAuthProfilePatch', () => {
    it('stores trimmed raw and canonical phone numbers together', () => {
        expect(buildAuthProfilePatch({
            phoneNumber: ['  +82 10-1234-5678  '],
        })).toEqual({
            phone_number: '+82 10-1234-5678',
            phone_number_normalized: '+821012345678',
        });
    });

    it.each([
        { phoneNumber: ['010-12-34'] },
        { phoneNumber: ['   '] },
        {},
    ] satisfies AuthProfileSource[])(
        'omits both phone fields for an invalid or absent phone',
        source => {
            const patch = buildAuthProfilePatch(source);

            expect(patch).not.toHaveProperty('phone_number');
            expect(patch).not.toHaveProperty('phone_number_normalized');
        }
    );

    it('uses ordered fallbacks, trims strings, and coerces a numeric birthyear', () => {
        expect(buildAuthProfilePatch({
            name: [null, '   ', '  Account Name  ', 'Ignored Name'],
            nickname: [undefined, '  Nickname  '],
            profileImage: ['', '  https://example.com/avatar.jpg  '],
            gender: [false, '  female  '],
            birthyear: [null, 1997],
            phoneNumber: ['not-a-phone', '  010-9876-5432  '],
        })).toEqual({
            name: 'Account Name',
            nickname: 'Nickname',
            profile_image: 'https://example.com/avatar.jpg',
            gender: 'female',
            birthyear: '1997',
            phone_number: '010-9876-5432',
            phone_number_normalized: '+821098765432',
        });
    });

    it('never copies email or provider into the profile patch', () => {
        const sourceWithForbiddenKeys = {
            name: ['  Kakao User  '],
            email: 'private@example.com',
            provider: 'kakao',
        } as AuthProfileSource & Record<'email' | 'provider', unknown>;

        const patch = buildAuthProfilePatch(sourceWithForbiddenKeys);

        expect(patch).toEqual({ name: 'Kakao User' });
        expect(patch).not.toHaveProperty('email');
        expect(patch).not.toHaveProperty('provider');
    });
});

describe('auth button provider compatibility contract', () => {
    const source = readFileSync(
        new URL('../../../components/auth-buttons.tsx', import.meta.url),
        'utf8'
    );
    const renderedSource = source.slice(source.indexOf('return ('));

    it('renders exactly the Kakao sign-in action', () => {
        const renderedActions = renderedSource.match(
            /onClick=\{\(\) => signIn\('(?:kakao|google)'\)\}/g
        ) ?? [];

        expect(renderedActions).toEqual([
            "onClick={() => signIn('kakao')}",
        ]);
        expect(renderedSource).toContain('{kakaoText}');
    });

    it('renders no Google sign-in action or copy', () => {
        expect(renderedSource).not.toMatch(
            /signIn\('google'\)|googleText|Google/
        );
    });

    it('keeps the internal Google OAuth branch for legacy compatibility', () => {
        expect(source).toContain("provider: 'kakao' | 'google'");
        expect(source).toMatch(
            /provider === 'kakao'[\s\S]*?: undefined/
        );
        expect(source).toMatch(/signInWithOAuth\(\{\s*provider,/);
    });
});

describe('auth profile integration contract', () => {
    const callbackSource = readFileSync(
        new URL('../../../app/auth/callback/route.ts', import.meta.url),
        'utf8'
    );
    const meRouteSource = readFileSync(
        new URL('../../../app/api/user/me/route.ts', import.meta.url),
        'utf8'
    );

    it('maps Kakao REST profile fallbacks through the shared helper', () => {
        expect(callbackSource).toContain('buildAuthProfilePatch({');
        expect(callbackSource).toMatch(
            /name:\s*\[account\.name,\s*profile\.nickname\]/
        );
        expect(callbackSource).toMatch(
            /profileImage:\s*\[profile\.profile_image_url,\s*profile\.thumbnail_image_url\]/
        );
        expect(callbackSource).toMatch(/phoneNumber:\s*\[account\.phone_number\]/);
    });

    it('keeps Kakao profile values and the provider token out of logs', () => {
        const logCalls = callbackSource.match(
            /console\.(?:error|log|warn)\([^;]*\);/g
        ) ?? [];
        const consoleCallCount = callbackSource.match(
            /console\.(?:error|log|warn)\(/g
        )?.length ?? 0;

        expect(logCalls).toHaveLength(consoleCallCount);
        expect(logCalls.join('\n')).not.toMatch(
            /\b(?:providerToken|provider_token|data|account|profilePatch|phone_number|profile_image|nickname|gender|birthyear|email|name)\b|error\.message/
        );
    });

    it('maps Supabase social metadata fallbacks through the shared helper', () => {
        expect(meRouteSource).toContain('buildAuthProfilePatch({');
        expect(meRouteSource).toMatch(/name:\s*\[m\.name,\s*m\.full_name\]/);
        expect(meRouteSource).toMatch(
            /nickname:\s*\[m\.nickname,\s*m\.preferred_username,\s*m\.user_name,\s*m\.name\]/
        );
        expect(meRouteSource).toMatch(
            /profileImage:\s*\[m\.avatar_url,\s*m\.picture,\s*m\.profile_image\]/
        );
        expect(meRouteSource).toMatch(
            /phoneNumber:\s*\[user\.phone,\s*m\.phone_number,\s*m\.phone\]/
        );
        expect(meRouteSource).toMatch(
            /birthyear:\s*\[m\.birthyear,\s*m\.birth_year\]/
        );
    });
});
