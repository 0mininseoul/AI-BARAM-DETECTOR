import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsMocks = vi.hoisted(() => ({
    identifyAnalyticsUser: vi.fn(),
    initAmplitude: vi.fn(),
    isCanonicalAnalyticsUserId: vi.fn(),
    markAnalyticsIdentityPending: vi.fn(),
    markAnalyticsIdentityReady: vi.fn(),
}));

const authMarkerMocks = vi.hoisted(() => ({
    completePendingAuthEvent: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: vi.fn(),
}));

vi.mock('@/lib/services/analytics', () => analyticsMocks);
vi.mock('@/lib/services/analytics-auth', () => authMarkerMocks);

const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('AmplitudeProvider auth integration', () => {
    beforeEach(() => {
        analyticsMocks.identifyAnalyticsUser.mockReset();
        analyticsMocks.initAmplitude.mockReset();
        analyticsMocks.isCanonicalAnalyticsUserId
            .mockReset()
            .mockImplementation((userId: string) => userId === VALID_USER_ID);
        analyticsMocks.markAnalyticsIdentityPending.mockReset();
        analyticsMocks.markAnalyticsIdentityReady.mockReset();
        authMarkerMocks.completePendingAuthEvent.mockReset();
    });

    it('opens initial anonymous delivery without resetting identity', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        let state = createAuthAnalyticsState();

        state = syncAnalyticsAuth(state, {
            loading: true,
            provider: null,
            userId: null,
        });
        state = syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
        });
        syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
        });

        expect(analyticsMocks.identifyAnalyticsUser).not.toHaveBeenCalled();
        expect(analyticsMocks.markAnalyticsIdentityPending).not.toHaveBeenCalled();
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).not.toHaveBeenCalled();
    });

    it('identifies before completing auth and deduplicates login and logout transitions', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        const storage = { getItem: vi.fn(), removeItem: vi.fn(), setItem: vi.fn() };
        let state = createAuthAnalyticsState();

        state = syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
            storage,
        });
        vi.clearAllMocks();

        state = syncAnalyticsAuth(state, {
            loading: false,
            provider: 'kakao',
            userId: VALID_USER_ID,
            storage,
        });
        state = syncAnalyticsAuth(state, {
            loading: false,
            provider: 'kakao',
            userId: VALID_USER_ID,
            storage,
        });

        expect(analyticsMocks.markAnalyticsIdentityPending).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledWith(VALID_USER_ID);
        expect(authMarkerMocks.completePendingAuthEvent).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).toHaveBeenCalledWith({
            provider: 'kakao',
            storage,
            userId: VALID_USER_ID,
        });
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.identifyAnalyticsUser.mock.invocationCallOrder[0])
            .toBeLessThan(authMarkerMocks.completePendingAuthEvent.mock.invocationCallOrder[0]);
        expect(authMarkerMocks.completePendingAuthEvent.mock.invocationCallOrder[0])
            .toBeLessThan(analyticsMocks.markAnalyticsIdentityReady.mock.invocationCallOrder[0]);

        vi.clearAllMocks();
        state = syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
            storage,
        });
        syncAnalyticsAuth(state, {
            loading: false,
            provider: null,
            userId: null,
            storage,
        });

        expect(analyticsMocks.markAnalyticsIdentityPending).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledWith(null);
        expect(analyticsMocks.markAnalyticsIdentityReady).toHaveBeenCalledTimes(1);
        expect(authMarkerMocks.completePendingAuthEvent).not.toHaveBeenCalled();
    });

    it('keeps the SDK behind one client provider mounted once at the root', () => {
        const providerSource = readFileSync(
            new URL('../../components/amplitude-provider.tsx', import.meta.url),
            'utf8',
        );
        const layoutSource = readFileSync(
            new URL('../../app/layout.tsx', import.meta.url),
            'utf8',
        );

        expect(providerSource.startsWith("'use client';")).toBe(true);
        expect(providerSource).not.toContain('@amplitude/unified');
        expect(layoutSource).not.toContain('@amplitude/unified');
        expect(layoutSource).toContain(
            'import { AmplitudeProvider } from "@/components/amplitude-provider";',
        );
        expect(layoutSource.match(/<AmplitudeProvider>/g)).toHaveLength(1);
        expect(layoutSource).toMatch(
            /<AmplitudeProvider>\s*\{children\}\s*<\/AmplitudeProvider>/,
        );
    });
});
