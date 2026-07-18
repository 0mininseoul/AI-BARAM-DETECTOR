import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const amplitudeMocks = vi.hoisted(() => ({
    initAll: vi.fn(),
    reset: vi.fn(),
    setUserId: vi.fn(),
    track: vi.fn(),
}));

vi.mock('@amplitude/unified', () => amplitudeMocks);

const API_KEY = 'test-key';
const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

async function loadAnalytics() {
    return import('./analytics');
}

function enableBrowser(apiKey = API_KEY) {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', apiKey);
}

describe('Amplitude analytics adapter', () => {
    beforeEach(() => {
        vi.resetModules();
        amplitudeMocks.initAll.mockReset();
        amplitudeMocks.initAll.mockResolvedValue(undefined);
        amplitudeMocks.reset.mockReset();
        amplitudeMocks.setUserId.mockReset();
        amplitudeMocks.track.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('exports only the approved fixed event catalog', async () => {
        const { EVENTS } = await loadAnalytics();

        expect(EVENTS).toEqual({
            LANDING_VIEWED: 'landing_viewed',
            TARGET_SUBMITTED: 'target_submitted',
            AUTH_STARTED: 'auth_started',
            AUTH_COMPLETED: 'auth_completed',
            PREFLIGHT_STARTED: 'preflight_started',
            PREFLIGHT_SUCCEEDED: 'preflight_succeeded',
            PREFLIGHT_FAILED: 'preflight_failed',
            EXCLUSION_DECIDED: 'exclusion_decided',
            PLAN_VIEWED: 'plan_viewed',
            PLAN_SELECTED: 'plan_selected',
            CHECKOUT_STARTED: 'checkout_started',
            CHECKOUT_REDIRECTED: 'checkout_redirected',
            PAYMENT_CONFIRMED_VIEWED: 'payment_confirmed_viewed',
            EARLYBIRD_STATUS_VIEWED: 'earlybird_status_viewed',
            ANALYSIS_STARTED: 'analysis_started',
            ANALYSIS_COMPLETED: 'analysis_completed',
            RESULT_VIEWED: 'result_viewed',
            RESULT_SHARED: 'result_shared',
        });
    });

    it('initializes once with the exact privacy-bounded Unified configuration', async () => {
        enableBrowser('  test-key  ');
        const { initAmplitude } = await loadAnalytics();

        const [firstResult, secondResult] = await Promise.all([
            initAmplitude(),
            initAmplitude(),
        ]);

        expect(firstResult).toBe(true);
        expect(secondResult).toBe(true);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.initAll).toHaveBeenCalledWith('test-key', {
            analytics: { autocapture: true },
            sessionReplay: {
                sampleRate: 1,
                privacyConfig: {
                    defaultMaskLevel: 'medium',
                    maskSelector: ['.amp-mask', '[data-amp-mask]'],
                    blockSelector: ['.amp-block', '[data-amp-block]'],
                },
            },
            engagement: { skip: true },
        });

        await expect(initAmplitude()).resolves.toBe(true);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('fails open on the server and for missing or blank keys', async () => {
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', API_KEY);
        const serverAnalytics = await loadAnalytics();

        await expect(serverAnalytics.initAmplitude()).resolves.toBe(false);

        vi.resetModules();
        vi.stubGlobal('window', {});
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', '   ');
        const blankKeyAnalytics = await loadAnalytics();

        await expect(blankKeyAnalytics.initAmplitude()).resolves.toBe(false);

        vi.resetModules();
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', '');
        const missingKeyAnalytics = await loadAnalytics();

        await expect(missingKeyAnalytics.initAmplitude()).resolves.toBe(false);
        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
    });

    it('clears a rejected initialization latch so a later call can retry', async () => {
        enableBrowser();
        amplitudeMocks.initAll
            .mockRejectedValueOnce(new Error('sdk unavailable'))
            .mockResolvedValueOnce(undefined);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude()).resolves.toBe(false);
        await expect(initAmplitude()).resolves.toBe(true);

        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(2);
    });

    it('does not track before initialization has resolved', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const { EVENTS, initAmplitude, trackEvent } = await loadAnalytics();

        const initialization = initAmplitude();
        trackEvent(EVENTS.LANDING_VIEWED, { source: 'direct' });
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        resolveInitialization();
        await expect(initialization).resolves.toBe(true);
        trackEvent(EVENTS.LANDING_VIEWED, { source: 'direct' });

        expect(amplitudeMocks.track).toHaveBeenCalledWith('landing_viewed', {
            source: 'direct',
        });
    });

    it('copies every allowlisted scalar property', async () => {
        enableBrowser();
        const { EVENTS, initAmplitude, trackEvent } = await loadAnalytics();
        await initAmplitude();
        const properties = {
            provider: 'kakao',
            source: 'search',
            medium: 'cpc',
            campaign: 'launch',
            content: 'hero',
            term: 'detector',
            plan_id: 'basic',
            required_plan_id: 'standard',
            amount_krw: 9900,
            stage: 'preflight',
            duration_ms: 42,
            error_code: 'NONE',
            followers_bucket: '0_400',
            following_bucket: '401_800',
            decision: 'eligible',
            preflight_id: 'preflight-1',
            order_id: 'order-1',
            request_id: 'request-1',
            status: 'ready',
            share_channel: 'kakao',
            is_shared: false,
            result_count: 0,
        };

        trackEvent(EVENTS.PREFLIGHT_SUCCEEDED, properties);

        expect(amplitudeMocks.track).toHaveBeenCalledWith(
            'preflight_succeeded',
            properties,
        );
    });

    it('discards forbidden fields and non-scalar or non-finite values', async () => {
        enableBrowser();
        const { EVENTS, initAmplitude, trackEvent } = await loadAnalytics();
        await initAmplitude();

        trackEvent(EVENTS.RESULT_VIEWED, {
            provider: 'kakao',
            duration_ms: 120,
            is_shared: true,
            amount_krw: Number.NaN,
            source: Number.POSITIVE_INFINITY,
            medium: Number.NEGATIVE_INFINITY,
            stage: null,
            status: ['paid'],
            decision: { value: 'eligible' },
            instagramId: 'raw-instagram-id',
            targetInstagramId: 'another-instagram-id',
            email: 'person@example.com',
            phone: '01012345678',
            bio: 'private bio',
            caption: 'private caption',
            comment: 'private comment',
            imageUrl: 'https://example.com/private.jpg',
            profileImage: 'https://example.com/profile.jpg',
            token: 'secret-token',
            unknown: 'not-approved',
        });

        expect(amplitudeMocks.track).toHaveBeenCalledWith('result_viewed', {
            provider: 'kakao',
            duration_ms: 120,
            is_shared: true,
        });
    });

    it('ignores unapproved runtime event names and never lets SDK tracking errors escape', async () => {
        enableBrowser();
        const { EVENTS, initAmplitude, trackEvent } = await loadAnalytics();
        await initAmplitude();

        trackEvent('legacy_event' as never, { source: 'direct' });
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        amplitudeMocks.track.mockImplementationOnce(() => {
            throw new Error('tracking failed');
        });
        expect(() => trackEvent(EVENTS.LANDING_VIEWED)).not.toThrow();
    });

    it('identifies only canonical UUIDs and resets a signed-out identity', async () => {
        enableBrowser();
        const {
            identifyAnalyticsUser,
            initAmplitude,
        } = await loadAnalytics();
        await initAmplitude();

        identifyAnalyticsUser(VALID_USER_ID);
        identifyAnalyticsUser('person@example.com');
        identifyAnalyticsUser('010-1234-5678');
        identifyAnalyticsUser('instagram_handle');
        identifyAnalyticsUser('550e8400e29b41d4a716446655440000');
        identifyAnalyticsUser(null);

        expect(amplitudeMocks.setUserId).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.setUserId).toHaveBeenCalledWith(VALID_USER_ID);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);
    });

    it('does not identify before initialization and contains SDK identity errors', async () => {
        enableBrowser();
        const { identifyAnalyticsUser, initAmplitude } = await loadAnalytics();

        identifyAnalyticsUser(VALID_USER_ID);
        identifyAnalyticsUser(null);
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();
        expect(amplitudeMocks.reset).not.toHaveBeenCalled();

        await initAmplitude();
        amplitudeMocks.setUserId.mockImplementationOnce(() => {
            throw new Error('identity failed');
        });
        amplitudeMocks.reset.mockImplementationOnce(() => {
            throw new Error('reset failed');
        });

        expect(() => identifyAnalyticsUser(VALID_USER_ID)).not.toThrow();
        expect(() => identifyAnalyticsUser(null)).not.toThrow();
    });
});
