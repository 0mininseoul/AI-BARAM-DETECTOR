import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsMocks = vi.hoisted(() => ({
    identifyAnalyticsUser: vi.fn(),
    initAmplitude: vi.fn(),
    isCanonicalAnalyticsUserId: vi.fn(),
    trackEvent: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
    useAuth: vi.fn(),
}));

vi.mock('@/lib/services/analytics', () => ({
    EVENTS: { AUTH_COMPLETED: 'auth_completed' },
    ...analyticsMocks,
}));

const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

function createStorage(marker: string | null = 'kakao') {
    let currentMarker = marker;

    return {
        getItem: vi.fn(() => currentMarker),
        removeItem: vi.fn(() => {
            currentMarker = null;
        }),
    };
}

describe('AmplitudeProvider auth integration', () => {
    beforeEach(() => {
        analyticsMocks.identifyAnalyticsUser.mockReset();
        analyticsMocks.initAmplitude.mockReset();
        analyticsMocks.isCanonicalAnalyticsUserId
            .mockReset()
            .mockImplementation((userId: string) => userId === VALID_USER_ID);
        analyticsMocks.trackEvent.mockReset();
    });

    it('completes and removes a pending auth marker only once for a valid user', async () => {
        const { completePendingAuthEvent } = await import('../../components/amplitude-provider');
        const storage = createStorage();

        expect(completePendingAuthEvent(VALID_USER_ID, storage)).toBe(true);
        expect(completePendingAuthEvent(VALID_USER_ID, storage)).toBe(false);

        expect(storage.removeItem).toHaveBeenCalledTimes(1);
        expect(storage.removeItem).toHaveBeenCalledWith('amplitude_auth_started');
        expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.trackEvent).toHaveBeenCalledWith('auth_completed');
    });

    it('ignores invalid users and fails open when storage is unavailable or throws', async () => {
        const { completePendingAuthEvent } = await import('../../components/amplitude-provider');
        const inaccessibleStorage = {
            getItem: vi.fn(() => {
                throw new Error('storage unavailable');
            }),
            removeItem: vi.fn(),
        };
        const nonRemovableStorage = {
            getItem: vi.fn(() => 'kakao'),
            removeItem: vi.fn(() => {
                throw new Error('storage unavailable');
            }),
        };

        expect(completePendingAuthEvent('person@example.com', createStorage())).toBe(false);
        expect(completePendingAuthEvent(VALID_USER_ID, undefined)).toBe(false);
        expect(completePendingAuthEvent(VALID_USER_ID, inaccessibleStorage)).toBe(false);
        expect(completePendingAuthEvent(VALID_USER_ID, nonRemovableStorage)).toBe(false);
        expect(analyticsMocks.trackEvent).not.toHaveBeenCalled();
    });

    it('identifies and resets once per resolved auth transition', async () => {
        const {
            createAuthAnalyticsState,
            syncAnalyticsAuth,
        } = await import('../../components/amplitude-provider');
        const storage = createStorage();
        let state = createAuthAnalyticsState();

        state = syncAnalyticsAuth(state, {
            loading: true,
            userId: null,
            storage,
        });
        expect(analyticsMocks.identifyAnalyticsUser).not.toHaveBeenCalled();

        state = syncAnalyticsAuth(state, {
            loading: false,
            userId: null,
            storage,
        });
        state = syncAnalyticsAuth(state, {
            loading: false,
            userId: null,
            storage,
        });
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledTimes(1);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenLastCalledWith(null);

        state = syncAnalyticsAuth(state, {
            loading: false,
            userId: VALID_USER_ID,
            storage,
        });
        state = syncAnalyticsAuth(state, {
            loading: false,
            userId: VALID_USER_ID,
            storage,
        });
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledTimes(2);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenLastCalledWith(VALID_USER_ID);
        expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(1);

        syncAnalyticsAuth(state, {
            loading: false,
            userId: null,
            storage,
        });
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenCalledTimes(3);
        expect(analyticsMocks.identifyAnalyticsUser).toHaveBeenLastCalledWith(null);
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
        expect(layoutSource).toContain(
            'import { AmplitudeProvider } from "@/components/amplitude-provider";',
        );
        expect(layoutSource.match(/<AmplitudeProvider>/g)).toHaveLength(1);
        expect(layoutSource).toMatch(
            /<AmplitudeProvider>\s*\{children\}\s*<\/AmplitudeProvider>/,
        );
    });
});
