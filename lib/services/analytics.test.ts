import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const amplitudeMocks = vi.hoisted(() => ({
    initAll: vi.fn(),
    moduleLoads: 0,
    reset: vi.fn(),
    setUserId: vi.fn(),
    track: vi.fn(),
}));

vi.mock('@amplitude/unified', () => {
    amplitudeMocks.moduleLoads += 1;
    return amplitudeMocks;
});

const API_KEY = '0123456789abcdef0123456789abcdef';
const VALID_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
        amplitudeMocks.moduleLoads = 0;
        amplitudeMocks.reset.mockReset();
        amplitudeMocks.setUserId.mockReset();
        amplitudeMocks.track.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('exports only canonical approved events with no legacy aliases', async () => {
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
        expect((EVENTS as Record<string, string>).CLICK_CTA_START).toBeUndefined();
        expect((EVENTS as Record<string, string>).VIEW_RESULT).toBeUndefined();
        expect((EVENTS as Record<string, string>).CLICK_SHARE_KAKAO).toBeUndefined();
    });

    it('initializes once with granular safe autocapture and conservative replay', async () => {
        enableBrowser();
        const { initAmplitude } = await loadAnalytics();

        const [firstResult, secondResult] = await Promise.all([
            initAmplitude(),
            initAmplitude(),
        ]);

        expect(firstResult).toBe(true);
        expect(secondResult).toBe(true);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
        expect(amplitudeMocks.initAll).toHaveBeenCalledWith(API_KEY, {
            analytics: {
                autocapture: {
                    sessions: true,
                    attribution: false,
                    pageViews: false,
                    formInteractions: false,
                    fileDownloads: false,
                    elementInteractions: false,
                    frustrationInteractions: false,
                    pageUrlEnrichment: false,
                    networkTracking: false,
                    webVitals: false,
                    performanceTracking: false,
                },
                fetchRemoteConfig: false,
                remoteConfig: { fetchRemoteConfig: false },
            },
            sessionReplay: {
                sampleRate: 1,
                privacyConfig: {
                    defaultMaskLevel: 'conservative',
                    maskSelector: ['.amp-mask', '[data-amp-mask]'],
                    blockSelector: ['.amp-block', '[data-amp-block]'],
                },
            },
            engagement: { skip: true },
        });

        await expect(initAmplitude()).resolves.toBe(true);
        expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1);
    });

    it('never loads Unified on the server or with a missing key', async () => {
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', API_KEY);
        const serverAnalytics = await loadAnalytics();

        await expect(serverAnalytics.initAmplitude()).resolves.toBe(false);
        expect(amplitudeMocks.moduleLoads).toBe(0);

        vi.resetModules();
        vi.stubGlobal('window', {});
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', '');
        const missingKeyAnalytics = await loadAnalytics();

        await expect(missingKeyAnalytics.initAmplitude()).resolves.toBe(false);
        expect(amplitudeMocks.moduleLoads).toBe(0);
        expect(amplitudeMocks.initAll).not.toHaveBeenCalled();
    });

    it.each([
        '   ',
        'xxx',
        'test-key',
        '00000000000000000000000000000000',
        '0123456789abcdef0123456789abcdeg',
        '0123456789abcdef0123456789abcdef00',
    ])('rejects malformed or placeholder API key %j before loading the SDK', async (apiKey) => {
        enableBrowser(apiKey);
        const { initAmplitude } = await loadAnalytics();

        await expect(initAmplitude()).resolves.toBe(false);
        expect(amplitudeMocks.moduleLoads).toBe(0);
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

    it('queues a valid child event until init and identity sync, coalescing StrictMode duplicates', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const {
            EVENTS,
            markAnalyticsIdentityReady,
            trackEvent,
        } = await loadAnalytics();

        trackEvent(EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });
        trackEvent(EVENTS.TARGET_SUBMITTED, { stage: 'anonymous' });

        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        markAnalyticsIdentityReady();
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        resolveInitialization();
        await vi.waitFor(() => expect(amplitudeMocks.track).toHaveBeenCalledTimes(1));
        expect(amplitudeMocks.track).toHaveBeenCalledWith('target_submitted', {
            stage: 'anonymous',
        });
    });

    it('bounds the pre-init queue to the latest 50 validated events', async () => {
        enableBrowser();
        let resolveInitialization!: () => void;
        amplitudeMocks.initAll.mockImplementationOnce(() => new Promise<void>((resolve) => {
            resolveInitialization = resolve;
        }));
        const {
            EVENTS,
            markAnalyticsIdentityReady,
            trackEvent,
        } = await loadAnalytics();

        for (let resultCount = 0; resultCount < 55; resultCount += 1) {
            trackEvent(EVENTS.RESULT_VIEWED, {
                request_id: VALID_USER_ID,
                result_count: resultCount,
                is_shared: false,
            });
        }

        await vi.waitFor(() => expect(amplitudeMocks.initAll).toHaveBeenCalledTimes(1));
        markAnalyticsIdentityReady();
        resolveInitialization();
        await vi.waitFor(() => expect(amplitudeMocks.track).toHaveBeenCalledTimes(50));

        expect(amplitudeMocks.track.mock.calls[0]).toEqual(['result_viewed', {
            request_id: VALID_USER_ID,
            result_count: 5,
            is_shared: false,
        }]);
        expect(amplitudeMocks.track.mock.calls.at(-1)).toEqual(['result_viewed', {
            request_id: VALID_USER_ID,
            result_count: 54,
            is_shared: false,
        }]);
    });

    it('does not retain events when the API key is invalid', async () => {
        enableBrowser('xxx');
        const analytics = await loadAnalytics();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, { source: 'direct' });
        vi.stubEnv('NEXT_PUBLIC_AMPLITUDE_API_KEY', API_KEY);
        await analytics.initAmplitude();
        analytics.markAnalyticsIdentityReady();

        expect(amplitudeMocks.track).not.toHaveBeenCalled();
    });

    it('applies identity recorded before init before flushing queued events', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        analytics.identifyAnalyticsUser(VALID_USER_ID);
        analytics.markAnalyticsIdentityReady();
        analytics.trackEvent(analytics.EVENTS.TARGET_SUBMITTED, {
            stage: 'authenticated',
        });

        await vi.waitFor(() => expect(amplitudeMocks.track).toHaveBeenCalledTimes(1));
        expect(amplitudeMocks.setUserId).toHaveBeenCalledWith(VALID_USER_ID);
        expect(amplitudeMocks.setUserId.mock.invocationCallOrder[0])
            .toBeLessThan(amplitudeMocks.track.mock.invocationCallOrder[0]);
    });

    it('applies an event-specific property schema', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude();
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.AUTH_STARTED, {
            provider: 'kakao',
            source: 'must_not_cross_event_schema',
            request_id: VALID_USER_ID,
        });
        analytics.trackEvent(analytics.EVENTS.RESULT_VIEWED, {
            request_id: VALID_USER_ID,
            result_count: 8,
            is_shared: false,
            provider: 'kakao',
            share_channel: 'clipboard',
            token: 'secret',
        });
        analytics.trackEvent(analytics.EVENTS.RESULT_SHARED, {
            request_id: SECOND_UUID,
            share_channel: 'web_share',
            result_count: 8,
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['auth_started', { provider: 'kakao' }],
            ['result_viewed', {
                request_id: VALID_USER_ID,
                result_count: 8,
                is_shared: false,
            }],
            ['result_shared', {
                request_id: SECOND_UUID,
                share_channel: 'web_share',
            }],
        ]);
    });

    it('rejects PII-shaped marketing strings and invalid bounded values', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude();
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, {
            source: 'person@example.com',
            medium: '01012345678',
            campaign: 'https://example.com/path',
            content: '@private_handle',
            term: 'private.handle',
        });
        analytics.trackEvent(analytics.EVENTS.PLAN_SELECTED, {
            plan_id: 'enterprise',
            required_plan_id: 'basic',
            amount_krw: Number.POSITIVE_INFINITY,
            preflight_id: 'not-a-uuid',
        });
        analytics.trackEvent(analytics.EVENTS.PREFLIGHT_SUCCEEDED, {
            duration_ms: -1,
            followers_bucket: '400_exact',
            following_bucket: 'unknown',
            error_code: 'private@example.com',
            preflight_id: VALID_USER_ID,
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['landing_viewed', {}],
            ['plan_selected', { required_plan_id: 'basic' }],
            ['preflight_succeeded', {
                following_bucket: 'unknown',
                preflight_id: VALID_USER_ID,
            }],
        ]);
    });

    it('accepts bounded scalar values for their authorized lifecycle events', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude();
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED, {
            source: 'google',
            medium: 'paid_social',
            campaign: 'launch_2026',
            content: 'hero-a',
            term: 'detector',
        });
        analytics.trackEvent(analytics.EVENTS.PREFLIGHT_SUCCEEDED, {
            duration_ms: 12_500,
            required_plan_id: 'standard',
            followers_bucket: '401_800',
            following_bucket: '801_1200',
            preflight_id: VALID_USER_ID,
        });
        analytics.trackEvent(analytics.EVENTS.PAYMENT_CONFIRMED_VIEWED, {
            order_id: SECOND_UUID,
            plan_id: 'basic',
            amount_krw: 14_900,
            status: 'paid',
        });

        expect(amplitudeMocks.track.mock.calls).toEqual([
            ['landing_viewed', {
                source: 'google',
                medium: 'paid_social',
                campaign: 'launch_2026',
                content: 'hero-a',
                term: 'detector',
            }],
            ['preflight_succeeded', {
                duration_ms: 12_500,
                required_plan_id: 'standard',
                followers_bucket: '401_800',
                following_bucket: '801_1200',
                preflight_id: VALID_USER_ID,
            }],
            ['payment_confirmed_viewed', {
                order_id: SECOND_UUID,
                plan_id: 'basic',
                amount_krw: 14_900,
                status: 'paid',
            }],
        ]);
    });

    it('ignores unapproved runtime events and contains SDK tracking errors', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();
        await analytics.initAmplitude();
        analytics.markAnalyticsIdentityReady();

        analytics.trackEvent('legacy_event' as never, { source: 'direct' });
        expect(amplitudeMocks.track).not.toHaveBeenCalled();

        amplitudeMocks.track.mockImplementationOnce(() => {
            throw new Error('tracking failed');
        });
        expect(() => analytics.trackEvent(analytics.EVENTS.LANDING_VIEWED)).not.toThrow();
    });

    it('identifies only canonical UUIDs and contains identity errors', async () => {
        enableBrowser();
        const analytics = await loadAnalytics();

        analytics.identifyAnalyticsUser(VALID_USER_ID);
        expect(amplitudeMocks.setUserId).not.toHaveBeenCalled();

        await analytics.initAmplitude();
        analytics.identifyAnalyticsUser(VALID_USER_ID);
        analytics.identifyAnalyticsUser('person@example.com');
        analytics.identifyAnalyticsUser('010-1234-5678');
        analytics.identifyAnalyticsUser('instagram_handle');
        analytics.identifyAnalyticsUser(null);

        expect(amplitudeMocks.setUserId).toHaveBeenCalledTimes(2);
        expect(amplitudeMocks.setUserId).toHaveBeenCalledWith(VALID_USER_ID);
        expect(amplitudeMocks.reset).toHaveBeenCalledTimes(1);

        amplitudeMocks.setUserId.mockImplementationOnce(() => {
            throw new Error('identity failed');
        });
        amplitudeMocks.reset.mockImplementationOnce(() => {
            throw new Error('reset failed');
        });
        expect(() => analytics.identifyAnalyticsUser(VALID_USER_ID)).not.toThrow();
        expect(() => analytics.identifyAnalyticsUser(null)).not.toThrow();
    });

    it('contains no static Unified SDK import', () => {
        const source = readFileSync(new URL('./analytics.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/import\s+(?:\*|\{)[\s\S]*?from\s+['"]@amplitude\/unified['"]/);
        expect(source).toContain("import('@amplitude/unified')");
    });
});
