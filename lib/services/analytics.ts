'use client';

export const EVENTS = {
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

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];
export type AnalyticsAuthProvider = 'google' | 'kakao';
export type AnalyticsShareChannel = 'clipboard' | 'kakao' | 'web_share';

type UnifiedSdk = typeof import('@amplitude/unified');
type AnalyticsScalar = string | number | boolean;
type AnalyticsProperties = Record<string, AnalyticsScalar>;

type PropertyName =
    | 'amount_krw'
    | 'campaign'
    | 'content'
    | 'decision'
    | 'duration_ms'
    | 'error_code'
    | 'followers_bucket'
    | 'following_bucket'
    | 'is_shared'
    | 'medium'
    | 'order_id'
    | 'plan_id'
    | 'preflight_id'
    | 'provider'
    | 'request_id'
    | 'required_plan_id'
    | 'result_count'
    | 'share_channel'
    | 'source'
    | 'stage'
    | 'status'
    | 'term';

type PropertyValidator = (value: unknown) => AnalyticsScalar | undefined;

const API_KEY_PATTERN = /^[0-9a-f]{32}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const MARKETING_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_QUEUED_EVENTS = 50;

const APPROVED_EVENTS = new Set<AnalyticsEvent>(Object.values(EVENTS));

function enumValidator<const T extends string>(values: readonly T[]): PropertyValidator {
    const allowed = new Set<string>(values);
    return (value) => typeof value === 'string' && allowed.has(value) ? value : undefined;
}

function integerValidator(minimum: number, maximum: number): PropertyValidator {
    return (value) => typeof value === 'number'
        && Number.isFinite(value)
        && Number.isInteger(value)
        && value >= minimum
        && value <= maximum
        ? value
        : undefined;
}

function marketingValidator(value: unknown): string | undefined {
    if (typeof value !== 'string' || !MARKETING_VALUE_PATTERN.test(value)) return undefined;
    if (/^\+?\d[\d\s()-]{6,}$/.test(value)) return undefined;
    if (value.includes('@') || value.includes('.') || value.includes('://')) return undefined;
    return value;
}

function uuidValidator(value: unknown): string | undefined {
    return typeof value === 'string' && CANONICAL_UUID.test(value) ? value : undefined;
}

const PROPERTY_VALIDATORS: Record<PropertyName, PropertyValidator> = {
    amount_krw: integerValidator(0, 10_000_000),
    campaign: marketingValidator,
    content: marketingValidator,
    decision: enumValidator(['exclude', 'skip']),
    duration_ms: integerValidator(0, 86_400_000),
    error_code: (value) => typeof value === 'string' && ERROR_CODE_PATTERN.test(value)
        ? value
        : undefined,
    followers_bucket: enumValidator(['unknown', '0_400', '401_800', '801_1200', 'over_1200']),
    following_bucket: enumValidator(['unknown', '0_400', '401_800', '801_1200', 'over_1200']),
    is_shared: (value) => typeof value === 'boolean' ? value : undefined,
    medium: marketingValidator,
    order_id: uuidValidator,
    plan_id: enumValidator(['basic', 'standard', 'plus']),
    preflight_id: uuidValidator,
    provider: enumValidator(['google', 'kakao']),
    request_id: uuidValidator,
    required_plan_id: enumValidator(['basic', 'standard', 'plus']),
    result_count: integerValidator(0, 10_000),
    share_channel: enumValidator(['clipboard', 'kakao', 'web_share']),
    source: marketingValidator,
    stage: enumValidator([
        'analysis',
        'anonymous',
        'authenticated',
        'checkout',
        'preflight',
        'profile',
        'relationships',
        'result',
    ]),
    status: enumValidator([
        'analysis_in_progress',
        'cancelled',
        'completed',
        'overflow_refund_required',
        'paid',
        'payment_failed',
        'payment_pending',
        'refund_pending',
        'refunded',
    ]),
    term: marketingValidator,
};

const EVENT_SCHEMAS: Record<AnalyticsEvent, readonly PropertyName[]> = {
    [EVENTS.LANDING_VIEWED]: ['source', 'medium', 'campaign', 'content', 'term'],
    [EVENTS.TARGET_SUBMITTED]: ['stage'],
    [EVENTS.AUTH_STARTED]: ['provider'],
    [EVENTS.AUTH_COMPLETED]: ['provider'],
    [EVENTS.PREFLIGHT_STARTED]: [],
    [EVENTS.PREFLIGHT_SUCCEEDED]: [
        'duration_ms',
        'required_plan_id',
        'followers_bucket',
        'following_bucket',
        'preflight_id',
    ],
    [EVENTS.PREFLIGHT_FAILED]: ['duration_ms', 'error_code', 'stage', 'preflight_id'],
    [EVENTS.EXCLUSION_DECIDED]: ['preflight_id', 'decision'],
    [EVENTS.PLAN_VIEWED]: ['plan_id', 'required_plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.PLAN_SELECTED]: ['plan_id', 'required_plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.CHECKOUT_STARTED]: ['plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.CHECKOUT_REDIRECTED]: ['plan_id', 'amount_krw', 'preflight_id'],
    [EVENTS.PAYMENT_CONFIRMED_VIEWED]: ['order_id', 'plan_id', 'amount_krw', 'status'],
    [EVENTS.EARLYBIRD_STATUS_VIEWED]: ['order_id', 'plan_id', 'amount_krw', 'status'],
    [EVENTS.ANALYSIS_STARTED]: ['request_id', 'plan_id', 'preflight_id'],
    [EVENTS.ANALYSIS_COMPLETED]: ['request_id', 'duration_ms'],
    [EVENTS.RESULT_VIEWED]: ['request_id', 'result_count', 'is_shared'],
    [EVENTS.RESULT_SHARED]: ['request_id', 'share_channel'],
};

interface QueuedEvent {
    eventName: AnalyticsEvent;
    fingerprint: string;
    properties: AnalyticsProperties;
}

let identityReady = false;
let initializationPromise: Promise<boolean> | null = null;
let initializedSdk: UnifiedSdk | null = null;
let sdkLoadPromise: Promise<UnifiedSdk> | null = null;
let desiredUserId: string | null | undefined;
const queuedEvents: QueuedEvent[] = [];

function configuredApiKey(): string | null {
    if (typeof window === 'undefined') return null;

    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY?.trim() ?? '';
    if (!API_KEY_PATTERN.test(apiKey) || /^([0-9a-f])\1{31}$/i.test(apiKey)) return null;
    return apiKey;
}

function loadUnifiedSdk(): Promise<UnifiedSdk> {
    if (!sdkLoadPromise) {
        sdkLoadPromise = import('@amplitude/unified').catch((error) => {
            sdkLoadPromise = null;
            throw error;
        });
    }
    return sdkLoadPromise;
}

function validateProperties(
    eventName: AnalyticsEvent,
    properties?: Record<string, unknown>,
): AnalyticsProperties {
    const validated: AnalyticsProperties = {};

    for (const propertyName of EVENT_SCHEMAS[eventName]) {
        const value = PROPERTY_VALIDATORS[propertyName](properties?.[propertyName]);
        if (value !== undefined) validated[propertyName] = value;
    }

    return validated;
}

function flushQueue(): void {
    if (!initializedSdk || !identityReady) return;

    while (queuedEvents.length > 0) {
        const event = queuedEvents.shift();
        if (!event) return;
        try {
            initializedSdk.track(event.eventName, event.properties);
        } catch {
            // Analytics delivery is best-effort and must not affect product behavior.
        }
    }
}

function enqueue(eventName: AnalyticsEvent, properties: AnalyticsProperties): void {
    const fingerprint = `${eventName}:${JSON.stringify(properties)}`;
    if (queuedEvents.some((event) => event.fingerprint === fingerprint)) return;
    if (queuedEvents.length === MAX_QUEUED_EVENTS) queuedEvents.shift();
    queuedEvents.push({ eventName, fingerprint, properties });
}

function applyDesiredIdentity(sdk: UnifiedSdk): void {
    try {
        if (desiredUserId === null) {
            sdk.reset();
        } else if (desiredUserId !== undefined) {
            sdk.setUserId(desiredUserId);
        }
    } catch {
        // Identity updates are best-effort and must not affect analytics startup.
    }
}

export function initAmplitude(): Promise<boolean> {
    const apiKey = configuredApiKey();
    if (!apiKey) return Promise.resolve(false);
    if (initializedSdk) return Promise.resolve(true);
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        try {
            const sdk = await loadUnifiedSdk();
            await sdk.initAll(apiKey, {
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
            initializedSdk = sdk;
            applyDesiredIdentity(sdk);
            flushQueue();
            return true;
        } catch {
            return false;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

export function trackEvent(
    eventName: AnalyticsEvent,
    properties?: Record<string, unknown>,
): void {
    if (!APPROVED_EVENTS.has(eventName) || !configuredApiKey()) return;

    try {
        enqueue(eventName, validateProperties(eventName, properties));
        if (initializedSdk) {
            flushQueue();
        } else {
            void initAmplitude();
        }
    } catch {
        // Validation and analytics must never interrupt the product flow.
    }
}

export function markAnalyticsIdentityPending(): void {
    identityReady = false;
}

export function markAnalyticsIdentityReady(): void {
    identityReady = true;
    flushQueue();
}

export function isCanonicalAnalyticsUserId(userId: string): boolean {
    return CANONICAL_UUID.test(userId);
}

export function identifyAnalyticsUser(userId: string | null): void {
    if (userId !== null && !isCanonicalAnalyticsUserId(userId)) return;

    desiredUserId = userId;
    if (!initializedSdk) return;

    applyDesiredIdentity(initializedSdk);
}
