import { supabaseAdmin } from '@/lib/supabase/admin';
import { getTransportConfig, buildRequest, type TransportConfig } from './transport';
import {
    createRequestStartGate,
    type RequestStartGate,
} from './rate-limit';
import {
    createSelfHostedProfileGlobalGate,
    getSelfHostedProfileGlobalGateConfig,
    type SelfHostedProfileGlobalGate,
} from './global-request-gate';
import { isInstagramUsername } from '../../username';

export const IG_APP_ID = '936619743392459';
export const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
export const SELFHOSTED_PROFILE_DEADLINE_COMPLETION_MARGIN_MS = 250;

export interface WebProfileRuntimeConfig {
    timeoutMs: number;
    retries: number;
    retryBaseDelayMs: number;
    minIntervalMs: number;
    circuitCooldownMs: number;
    schemaFailureThreshold: number;
    transientFailureThreshold: number;
    maxRetryAfterMs: number;
}

export interface WebProfileFetchOptions {
    globalGateWaitMode?: ProfileValidationMode;
    invocationDeadlineAtMs?: number;
    onRequest?(): void;
}

type ProfileValidationMode = 'full' | 'admission';

export type WebProfileFailureKind =
    | 'auth'
    | 'circuit'
    | 'http'
    | 'rate_limit'
    | 'schema'
    | 'timeout'
    | 'transport';

export interface WebProfileFailureClassification {
    kind: WebProfileFailureKind;
    retryable: boolean;
    httpStatus: number | null;
}

class WebProfileRequestError extends Error {
    constructor(
        message: string,
        readonly kind: WebProfileFailureKind,
        readonly retryable: boolean,
        readonly retryAfterMs?: number,
        readonly httpStatus: number | null = null
    ) {
        super(message);
        this.name = 'WebProfileRequestError';
    }
}

/** PII-free metadata for routing and telemetry. The provider message stays private. */
export function classifyWebProfileFailure(
    error: unknown
): WebProfileFailureClassification | null {
    if (!(error instanceof WebProfileRequestError)) return null;
    return Object.freeze({
        kind: error.kind,
        retryable: error.retryable,
        httpStatus: error.httpStatus,
    });
}

declare const webProfileCircuitRetryPermitBrand: unique symbol;
declare const webProfileCircuitAttemptPermitBrand: unique symbol;

export interface WebProfileCircuitRetryPermit {
    readonly [webProfileCircuitRetryPermitBrand]: true;
}

export interface WebProfileCircuitAttemptPermit {
    readonly [webProfileCircuitAttemptPermitBrand]: true;
}

export interface WebProfileCircuitBreaker {
    acquireAttempt(retryPermit?: WebProfileCircuitRetryPermit): WebProfileCircuitAttemptPermit;
    assertAvailable(attemptPermit: WebProfileCircuitAttemptPermit): void;
    recordSuccess(attemptPermit: WebProfileCircuitAttemptPermit): void;
    recordFailure(
        error: WebProfileRequestError,
        config: WebProfileRuntimeConfig,
        attemptPermit: WebProfileCircuitAttemptPermit
    ): WebProfileCircuitRetryPermit | undefined;
}

interface WebProfileFetcherDeps {
    env?: Record<string, string | undefined>;
    fetchFn?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    gate?: RequestStartGate;
    globalGate?: SelfHostedProfileGlobalGate;
    circuit?: WebProfileCircuitBreaker;
}

type SharedWebProfileFetcherDeps = Omit<WebProfileFetcherDeps, 'circuit'> & {
    profileCircuit?: WebProfileCircuitBreaker;
    admissionCircuit?: WebProfileCircuitBreaker;
};

function globalGateAttemptOptions(input: {
    deadlineAtMs?: number;
    gateConfig: ReturnType<typeof getSelfHostedProfileGlobalGateConfig>;
    mode: ProfileValidationMode;
    now: () => number;
    requestTimeoutMs: number;
}) {
    const configuredMaxWaitMs = input.mode === 'admission'
        ? input.gateConfig.admissionMaxWaitMs
        : input.gateConfig.fullMaxWaitMs;
    const common = {
        responseGuardMs: input.gateConfig.responseGuardMs,
        rpcTimeoutMs: input.gateConfig.rpcTimeoutMs,
    };
    if (input.deadlineAtMs === undefined) {
        return { ...common, maxWaitMs: configuredMaxWaitMs };
    }

    const gateDeadlineAtMs = input.deadlineAtMs
        - input.requestTimeoutMs
        - SELFHOSTED_PROFILE_DEADLINE_COMPLETION_MARGIN_MS;
    const waitBudgetMs = Math.floor(
        gateDeadlineAtMs - input.now() - input.gateConfig.rpcTimeoutMs
    );
    if (!Number.isSafeInteger(waitBudgetMs) || waitBudgetMs < 0) {
        throw new WebProfileRequestError(
            'SELFHOSTED_PROFILE_COORDINATION_ERROR: caller deadline exhausted.',
            'transport',
            true
        );
    }
    return {
        ...common,
        deadlineAtMs: gateDeadlineAtMs,
        maxWaitMs: Math.min(configuredMaxWaitMs, waitBudgetMs),
    };
}

function integerSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 ${min}~${max} 범위의 정수여야 합니다.`);
    }
    return value;
}

export function getWebProfileConfig(
    env: Record<string, string | undefined> = process.env
): WebProfileRuntimeConfig {
    return {
        timeoutMs: integerSetting(env, 'SELFHOSTED_PROFILE_TIMEOUT_MS', 8_000, 250, 60_000),
        retries: integerSetting(env, 'SELFHOSTED_PROFILE_RETRIES', 1, 0, 3),
        retryBaseDelayMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS',
            750,
            0,
            30_000
        ),
        minIntervalMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_MIN_INTERVAL_MS',
            300,
            0,
            60_000
        ),
        circuitCooldownMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS',
            60_000,
            1_000,
            600_000
        ),
        schemaFailureThreshold: integerSetting(
            env,
            'SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD',
            2,
            1,
            10
        ),
        transientFailureThreshold: integerSetting(
            env,
            'SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD',
            3,
            1,
            10
        ),
        maxRetryAfterMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS',
            60_000,
            0,
            300_000
        ),
    };
}

export function createWebProfileCircuitBreaker(
    now: () => number = Date.now
): WebProfileCircuitBreaker {
    type RetryPermitState = WebProfileCircuitRetryPermit & { generation: number };
    type AttemptPermitState = WebProfileCircuitAttemptPermit & {
        generation: number;
        probe: boolean;
    };

    let openUntil = 0;
    let schemaFailures = 0;
    let transientFailures = 0;
    let generation = 0;
    let pendingRetryPermit: RetryPermitState | undefined;
    let activeProbePermit: AttemptPermitState | undefined;

    const circuitError = () => new WebProfileRequestError(
        'SCRAPING_ERROR: selfhosted profile circuit is open.',
        'circuit',
        false
    );

    const expireOpenCircuit = (): void => {
        if (openUntil !== 0 && openUntil <= now()) {
            openUntil = 0;
            pendingRetryPermit = undefined;
            activeProbePermit = undefined;
        }
    };

    const issueRetryPermit = (): WebProfileCircuitRetryPermit => {
        const retryPermit = { generation } as RetryPermitState;
        pendingRetryPermit = retryPermit;
        return retryPermit;
    };

    const openCircuit = (
        durationMs: number,
        shouldIssueRetryPermit: boolean
    ): WebProfileCircuitRetryPermit | undefined => {
        generation++;
        openUntil = Math.max(openUntil, now() + durationMs);
        pendingRetryPermit = undefined;
        activeProbePermit = undefined;
        if (!shouldIssueRetryPermit) return undefined;

        return issueRetryPermit();
    };

    return {
        acquireAttempt(retryPermit): WebProfileCircuitAttemptPermit {
            expireOpenCircuit();
            if (openUntil > now()) {
                const permit = retryPermit as RetryPermitState | undefined;
                if (
                    permit === undefined
                    || permit !== pendingRetryPermit
                    || permit.generation !== generation
                ) {
                    throw circuitError();
                }
                pendingRetryPermit = undefined;
                const attemptPermit = {
                    generation,
                    probe: true,
                } as AttemptPermitState;
                activeProbePermit = attemptPermit;
                return attemptPermit;
            }

            return { generation, probe: false } as AttemptPermitState;
        },
        assertAvailable(attemptPermit): void {
            expireOpenCircuit();
            const permit = attemptPermit as AttemptPermitState;
            if (
                permit.generation !== generation
                || (openUntil > now() && permit !== activeProbePermit)
            ) {
                throw circuitError();
            }
        },
        recordSuccess(attemptPermit): void {
            const permit = attemptPermit as AttemptPermitState;
            if (permit.generation !== generation) return;
            openUntil = 0;
            schemaFailures = 0;
            transientFailures = 0;
            pendingRetryPermit = undefined;
            activeProbePermit = undefined;
        },
        recordFailure(error, config, attemptPermit): WebProfileCircuitRetryPermit | undefined {
            const permit = attemptPermit as AttemptPermitState;
            const wasCurrentProbe = attemptPermit === activeProbePermit
                && permit.generation === generation;
            if (wasCurrentProbe) activeProbePermit = undefined;
            if (error.kind === 'rate_limit' || error.kind === 'auth') {
                return openCircuit(
                    Math.max(config.circuitCooldownMs, error.retryAfterMs ?? 0),
                    error.kind === 'rate_limit'
                );
            }
            if (error.kind === 'schema') {
                schemaFailures++;
                if (schemaFailures >= config.schemaFailureThreshold) {
                    return openCircuit(config.circuitCooldownMs, true);
                }
                if (
                    error.retryable
                    && wasCurrentProbe
                    && permit.generation === generation
                    && openUntil > now()
                ) {
                    return issueRetryPermit();
                }
                return undefined;
            }
            if (
                error.kind === 'timeout' ||
                error.kind === 'transport' ||
                (error.kind === 'http' && error.retryable)
            ) {
                transientFailures++;
                if (transientFailures >= config.transientFailureThreshold) {
                    return openCircuit(config.circuitCooldownMs, false);
                }
            }
            return undefined;
        },
    };
}

function profileUrl(username: string): string {
    return `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
}

function parseRetryAfter(
    response: Response,
    now: () => number,
    maximumMs: number
): number | undefined {
    const raw = response.headers.get('retry-after');
    if (raw === null || raw.trim() === '') return undefined;
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : Math.max(0, Date.parse(raw) - now());
    return Number.isFinite(delay) ? Math.min(delay, maximumMs) : undefined;
}

function responseError(
    response: Response,
    now: () => number,
    maximumRetryAfterMs: number
): WebProfileRequestError {
    const retryAfterMs = parseRetryAfter(response, now, maximumRetryAfterMs);
    if (response.status === 401 || response.status === 403) {
        return new WebProfileRequestError(
            `SCRAPING_ERROR: web_profile_info authorization failure (HTTP ${response.status}).`,
            'auth',
            false,
            retryAfterMs,
            response.status
        );
    }
    if (response.status === 429) {
        return new WebProfileRequestError(
            'SCRAPING_ERROR: web_profile_info rate limited (HTTP 429).',
            'rate_limit',
            true,
            retryAfterMs,
            response.status
        );
    }
    const retryable = response.status === 408 || response.status === 425 || response.status >= 500;
    return new WebProfileRequestError(
        `SCRAPING_ERROR: web_profile_info request failed (HTTP ${response.status}).`,
        'http',
        retryable,
        retryAfterMs,
        response.status
    );
}

function schemaError(message: string): WebProfileRequestError {
    return new WebProfileRequestError(message, 'schema', true);
}

function validOptionalUrl(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

function validateRawUser(user: Record<string, unknown>, expectedUsername: string): void {
    if (
        typeof user.username !== 'string' ||
        !isInstagramUsername(user.username) ||
        user.username.toLowerCase() !== expectedUsername.toLowerCase()
    ) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info username mismatch.');
    }
    for (const key of ['edge_followed_by', 'edge_follow', 'edge_owner_to_timeline_media']) {
        const edge = user[key];
        const count = edge && typeof edge === 'object' && !Array.isArray(edge)
            ? (edge as Record<string, unknown>).count
            : undefined;
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
            throw schemaError(`SCRAPING_SCHEMA_ERROR: web_profile_info ${key}.count invalid.`);
        }
    }
    if (typeof user.is_private !== 'boolean' || typeof user.is_verified !== 'boolean') {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info privacy flags invalid.');
    }
    for (const key of ['external_url', 'profile_pic_url', 'profile_pic_url_hd']) {
        if (!validOptionalUrl(user[key])) {
            throw schemaError(`SCRAPING_SCHEMA_ERROR: web_profile_info ${key} invalid.`);
        }
    }
}

function validateAdmissionRawUser(
    user: Record<string, unknown>,
    expectedUsername: string
): void {
    if (
        typeof user.username !== 'string'
        || !isInstagramUsername(user.username)
        || user.username.toLowerCase() !== expectedUsername.toLowerCase()
    ) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info admission username mismatch.');
    }
    for (const key of ['edge_followed_by', 'edge_follow']) {
        const edge = user[key];
        const count = edge && typeof edge === 'object' && !Array.isArray(edge)
            ? (edge as Record<string, unknown>).count
            : undefined;
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
            throw schemaError(
                `SCRAPING_SCHEMA_ERROR: web_profile_info admission ${key}.count invalid.`
            );
        }
    }
    if (typeof user.is_private !== 'boolean') {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info admission privacy invalid.');
    }
}

function parseUser(
    payload: unknown,
    expectedUsername: string,
    validationMode: ProfileValidationMode
): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info response is not an object.');
    }
    const root = payload as Record<string, unknown>;
    if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info data is missing.');
    }
    const data = root.data as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(data, 'user')) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info user field is missing.');
    }
    if (data.user === null) return null;
    if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user)) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info user field is invalid.');
    }
    const user = data.user as Record<string, unknown>;
    if (validationMode === 'admission') validateAdmissionRawUser(user, expectedUsername);
    else validateRawUser(user, expectedUsername);
    return user;
}

function makeWebProfileFetcherForMode(
    validationMode: ProfileValidationMode,
    deps: WebProfileFetcherDeps = {}
) {
    const fetchFn = deps.fetchFn ?? fetch;
    const now = deps.now ?? Date.now;
    const wait = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const gate = deps.gate ?? createRequestStartGate(now, wait);
    const globalGate = deps.globalGate ?? createSelfHostedProfileGlobalGate({
        client: supabaseAdmin,
        sleep: wait,
    });
    const circuit = deps.circuit ?? createWebProfileCircuitBreaker(now);

    return async function fetchProfile(
        username: string,
        transport: TransportConfig = getTransportConfig(deps.env ?? process.env),
        options: WebProfileFetchOptions = {}
    ): Promise<Record<string, unknown> | null> {
        if (!isInstagramUsername(username)) {
            throw new Error('SCRAPING_CONFIG_ERROR: Instagram username 형식이 올바르지 않습니다.');
        }
        const config = getWebProfileConfig(deps.env ?? process.env);
        const globalGateConfig = getSelfHostedProfileGlobalGateConfig(
            deps.env ?? process.env
        );
        const { url } = buildRequest(profileUrl(username), transport);
        let lastError: unknown;
        let retryPermit: WebProfileCircuitRetryPermit | undefined;

        for (let attempt = 0; attempt <= config.retries; attempt++) {
            const attemptPermit = circuit.acquireAttempt(retryPermit);
            retryPermit = undefined;
            try {
                circuit.assertAvailable(attemptPermit);
                const result = await gate.schedule(async () => {
                    circuit.assertAvailable(attemptPermit);
                    const controller = new AbortController();
                    const requestInit: RequestInit = {
                        headers: {
                            'x-ig-app-id': IG_APP_ID,
                            'User-Agent': USER_AGENT,
                            Accept: '*/*',
                            'X-Requested-With': 'XMLHttpRequest',
                            Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
                        },
                        signal: controller.signal,
                    };
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const startRequest = (): Promise<Response> => {
                        timer = setTimeout(() => controller.abort(), config.timeoutMs);
                        try {
                            return fetchFn(url, requestInit);
                        } catch (error) {
                            clearTimeout(timer);
                            timer = undefined;
                            throw error;
                        }
                    };
                    let request: Promise<Response>;
                    if (globalGateConfig.enabled) {
                        const gateOptions = globalGateAttemptOptions({
                            deadlineAtMs: options.invocationDeadlineAtMs,
                            gateConfig: globalGateConfig,
                            mode: options.globalGateWaitMode ?? validationMode,
                            now,
                            requestTimeoutMs: config.timeoutMs,
                        });
                        const handoff = await globalGate.reserveWaitAndStart(
                            globalGateConfig.minIntervalMs,
                            { ...gateOptions },
                            {
                                beforeStart: () => circuit.assertAvailable(attemptPermit),
                                start: () => {
                                    const startedRequest = startRequest();
                                    try {
                                        options.onRequest?.();
                                    } catch (error) {
                                        controller.abort();
                                        if (timer !== undefined) {
                                            clearTimeout(timer);
                                            timer = undefined;
                                        }
                                        void startedRequest.catch(() => undefined);
                                        throw error;
                                    }
                                    return startedRequest;
                                },
                            }
                        );
                        request = handoff.started;
                    } else {
                        options.onRequest?.();
                        request = startRequest();
                    }
                    try {
                        const response = await request;
                        if (response.status === 404) return null;
                        if (!response.ok) {
                            throw responseError(response, now, config.maxRetryAfterMs);
                        }
                        let payload: unknown;
                        try {
                            payload = await response.json();
                        } catch (error) {
                            if (error instanceof Error && error.name === 'AbortError') throw error;
                            throw new WebProfileRequestError(
                                'SCRAPING_SCHEMA_ERROR: web_profile_info returned invalid JSON.',
                                'schema',
                                true
                            );
                        }
                        return parseUser(payload, username, validationMode);
                    } finally {
                        if (timer !== undefined) clearTimeout(timer);
                    }
                }, config.minIntervalMs);
                circuit.recordSuccess(attemptPermit);
                return result;
            } catch (error) {
                const classified = error instanceof WebProfileRequestError
                    ? error
                    : error instanceof Error && error.name === 'AbortError'
                      ? new WebProfileRequestError(
                          'SCRAPING_TIMEOUT_ERROR: web_profile_info request timed out.',
                          'timeout',
                          true
                      )
                      : new WebProfileRequestError(
                          'SCRAPING_ERROR: web_profile_info transport request failed.',
                          'transport',
                          true
                      );
                lastError = classified;
                retryPermit = circuit.recordFailure(classified, config, attemptPermit);
                if (!classified.retryable || attempt >= config.retries) break;
                const backoffMs = config.retryBaseDelayMs * 2 ** attempt;
                await wait(Math.max(backoffMs, classified.retryAfterMs ?? 0));
            }
        }
        throw lastError;
    };
}

export function makeWebProfileFetcher(deps: WebProfileFetcherDeps = {}) {
    return makeWebProfileFetcherForMode('full', deps);
}

export function makeWebProfileAdmissionFetcher(deps: WebProfileFetcherDeps = {}) {
    return makeWebProfileFetcherForMode('admission', deps);
}

export function createSharedWebProfileFetchers(deps: SharedWebProfileFetcherDeps = {}) {
    const now = deps.now ?? Date.now;
    const wait = deps.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const sharedStartGate = deps.gate ?? createRequestStartGate(now, wait);
    const sharedGlobalGate = deps.globalGate ?? createSelfHostedProfileGlobalGate({
        client: supabaseAdmin,
        sleep: wait,
    });
    const commonDeps = {
        env: deps.env,
        fetchFn: deps.fetchFn,
        now,
        sleep: wait,
        gate: sharedStartGate,
        globalGate: sharedGlobalGate,
    };
    return {
        full: makeWebProfileFetcher({
            ...commonDeps,
            circuit: deps.profileCircuit ?? createWebProfileCircuitBreaker(now),
        }),
        admission: makeWebProfileAdmissionFetcher({
            ...commonDeps,
            circuit: deps.admissionCircuit ?? createWebProfileCircuitBreaker(now),
        }),
    };
}

const sharedDefaultFetchers = createSharedWebProfileFetchers();

export async function fetchWebProfileUser(
    username: string,
    transport?: TransportConfig,
    options?: WebProfileFetchOptions
): Promise<Record<string, unknown> | null> {
    return sharedDefaultFetchers.full(username, transport, options);
}

export async function fetchWebProfileAdmissionUser(
    username: string,
    transport?: TransportConfig,
    options?: WebProfileFetchOptions
): Promise<Record<string, unknown> | null> {
    return sharedDefaultFetchers.admission(username, transport, options);
}
