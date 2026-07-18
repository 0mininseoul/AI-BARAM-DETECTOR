'use client';

import * as amplitude from '@amplitude/unified';

const CANONICAL_EVENTS = {
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
} as const;

type CanonicalEvents = typeof CANONICAL_EVENTS;
type LegacyCallerAliases = {
    readonly CLICK_CTA_START: CanonicalEvents['TARGET_SUBMITTED'];
    readonly CLICK_SHARE_KAKAO: CanonicalEvents['RESULT_SHARED'];
    readonly VIEW_RESULT: CanonicalEvents['RESULT_VIEWED'];
};

// These non-enumerable aliases keep current callers working without expanding
// the approved event-name catalog. The callers migrate to canonical keys later.
export const EVENTS = Object.defineProperties(CANONICAL_EVENTS, {
    CLICK_CTA_START: { value: CANONICAL_EVENTS.TARGET_SUBMITTED },
    CLICK_SHARE_KAKAO: { value: CANONICAL_EVENTS.RESULT_SHARED },
    VIEW_RESULT: { value: CANONICAL_EVENTS.RESULT_VIEWED },
}) as CanonicalEvents & LegacyCallerAliases;

export type AnalyticsEvent = CanonicalEvents[keyof CanonicalEvents];

const APPROVED_EVENTS = new Set<AnalyticsEvent>(Object.values(CANONICAL_EVENTS));

const ALLOWED_PROPERTIES = new Set([
    'provider',
    'source',
    'medium',
    'campaign',
    'content',
    'term',
    'plan_id',
    'required_plan_id',
    'amount_krw',
    'stage',
    'duration_ms',
    'error_code',
    'followers_bucket',
    'following_bucket',
    'decision',
    'preflight_id',
    'order_id',
    'request_id',
    'status',
    'share_channel',
    'is_shared',
    'result_count',
]);

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let initialized = false;
let initializationPromise: Promise<boolean> | null = null;

export function initAmplitude(): Promise<boolean> {
    if (initialized) return Promise.resolve(true);
    if (typeof window === 'undefined') return Promise.resolve(false);

    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY?.trim();
    if (!apiKey) return Promise.resolve(false);
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        try {
            await amplitude.initAll(apiKey, {
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
            initialized = true;
            return true;
        } catch {
            return false;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

function isAllowedScalar(value: unknown): value is string | number | boolean {
    if (typeof value === 'number') return Number.isFinite(value);
    return typeof value === 'string' || typeof value === 'boolean';
}

function filterProperties(properties?: Record<string, unknown>) {
    const filtered: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(properties ?? {})) {
        if (ALLOWED_PROPERTIES.has(key) && isAllowedScalar(value)) {
            filtered[key] = value;
        }
    }

    return filtered;
}

export function trackEvent(
    eventName: AnalyticsEvent,
    properties?: Record<string, unknown>,
): void {
    if (!initialized || !APPROVED_EVENTS.has(eventName)) return;

    try {
        amplitude.track(eventName, filterProperties(properties));
    } catch {
        // Analytics must never interrupt the product flow.
    }
}

export function isCanonicalAnalyticsUserId(userId: string): boolean {
    return CANONICAL_UUID.test(userId);
}

export function identifyAnalyticsUser(userId: string | null): void {
    if (!initialized) return;

    try {
        if (userId === null) {
            amplitude.reset();
            return;
        }

        if (isCanonicalAnalyticsUserId(userId)) {
            amplitude.setUserId(userId);
        }
    } catch {
        // Identity updates are best-effort and must not affect authentication.
    }
}
