import { z } from 'zod';

export const SELFHOSTED_PROFILE_GLOBAL_GATE_RPC =
    'reserve_selfhosted_profile_request_start' as const;
export const SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS = 300_000;

const reservationSchema = z.object({
    schemaVersion: z.literal(1),
    waitMs: z.number().int().min(0).max(SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS),
    reservedAt: z.string().datetime({ offset: true }),
}).strict();

export type SelfHostedProfileRequestStartReservation = z.infer<typeof reservationSchema>;

interface RpcResult {
    data: unknown;
    error: unknown;
}

export interface SelfHostedProfileGlobalGateRpcBuilder extends PromiseLike<RpcResult> {
    abortSignal(signal: AbortSignal): PromiseLike<RpcResult>;
}

export interface SelfHostedProfileGlobalGateRpcClient {
    rpc(
        name: typeof SELFHOSTED_PROFILE_GLOBAL_GATE_RPC,
        params: {
            p_max_wait_ms: number;
            p_min_interval_ms: number;
            p_response_guard_ms: number;
        }
    ): SelfHostedProfileGlobalGateRpcBuilder;
}

export interface SelfHostedProfileGlobalGateConfig {
    admissionMaxWaitMs: number;
    enabled: boolean;
    fullMaxWaitMs: number;
    minIntervalMs: number;
    responseGuardMs: number;
    rpcTimeoutMs: number;
}

export interface SelfHostedProfileGlobalGateAttemptOptions {
    deadlineAtMs?: number;
    maxWaitMs: number;
    responseGuardMs: number;
    rpcTimeoutMs: number;
}

export interface SelfHostedProfileGlobalGate {
    reserveAndWait(
        minIntervalMs: number,
        options?: SelfHostedProfileGlobalGateAttemptOptions
    ): Promise<SelfHostedProfileRequestStartReservation>;
}

function coordinationError(): Error {
    return new Error(
        'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
    );
}

function enabledSetting(env: Record<string, string | undefined>): boolean {
    const raw = env.SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED;
    if (raw === undefined) return env.NODE_ENV === 'production';
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(
        'SCRAPING_CONFIG_ERROR: SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED must be true or false.'
    );
}

function intervalSetting(env: Record<string, string | undefined>): number {
    const raw = env.SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS;
    if (raw === undefined) return 750;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 250 || value > 60_000) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS must be an integer from 250 to 60000.'
        );
    }
    return value;
}

function boundedIntegerSetting(
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
        throw new Error(
            `SCRAPING_CONFIG_ERROR: ${key} must be an integer from ${min} to ${max}.`
        );
    }
    return value;
}

export function getSelfHostedProfileGlobalGateConfig(
    env: Record<string, string | undefined> = process.env
): SelfHostedProfileGlobalGateConfig {
    return {
        admissionMaxWaitMs: boundedIntegerSetting(
            env,
            'SELFHOSTED_PROFILE_GLOBAL_ADMISSION_MAX_WAIT_MS',
            500,
            0,
            SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS
        ),
        enabled: enabledSetting(env),
        fullMaxWaitMs: boundedIntegerSetting(
            env,
            'SELFHOSTED_PROFILE_GLOBAL_FULL_MAX_WAIT_MS',
            60_000,
            0,
            SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS
        ),
        minIntervalMs: intervalSetting(env),
        responseGuardMs: boundedIntegerSetting(
            env,
            'SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS',
            100,
            50,
            1_000
        ),
        rpcTimeoutMs: boundedIntegerSetting(
            env,
            'SELFHOSTED_PROFILE_GLOBAL_RPC_TIMEOUT_MS',
            750,
            100,
            5_000
        ),
    };
}

export async function reserveSelfHostedProfileRequestStart(
    client: SelfHostedProfileGlobalGateRpcClient,
    minIntervalMs: number,
    options: SelfHostedProfileGlobalGateAttemptOptions = {
        maxWaitMs: SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS,
        responseGuardMs: 100,
        rpcTimeoutMs: 750,
    },
    wallNow: () => number = Date.now
): Promise<SelfHostedProfileRequestStartReservation> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadlineRemainingMs = options.deadlineAtMs === undefined
            ? options.rpcTimeoutMs
            : options.deadlineAtMs - wallNow();
        const effectiveTimeoutMs = Math.min(
            options.rpcTimeoutMs,
            Math.floor(deadlineRemainingMs)
        );
        if (!Number.isSafeInteger(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
            throw coordinationError();
        }

        const controller = new AbortController();
        const builder = client.rpc(SELFHOSTED_PROFILE_GLOBAL_GATE_RPC, {
            p_max_wait_ms: options.maxWaitMs,
            p_min_interval_ms: minIntervalMs,
            p_response_guard_ms: options.responseGuardMs,
        });
        const request = Promise.resolve(builder.abortSignal(controller.signal));
        const hardTimeout = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                controller.abort();
                reject(coordinationError());
            }, effectiveTimeoutMs);
        });
        const result = await Promise.race([request, hardTimeout]);
        if (result.error !== null) throw coordinationError();
        const parsed = reservationSchema.safeParse(result.data);
        if (!parsed.success) throw coordinationError();
        return parsed.data;
    } catch {
        throw coordinationError();
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

export function createSelfHostedProfileGlobalGate(input: {
    client: SelfHostedProfileGlobalGateRpcClient;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    wallNow?: () => number;
}): SelfHostedProfileGlobalGate {
    const sleep = input.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = input.now ?? (() => performance.now());
    return {
        async reserveAndWait(minIntervalMs, options = {
            maxWaitMs: SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS,
            responseGuardMs: 100,
            rpcTimeoutMs: 750,
        }) {
            const rpcStartedAt = now();
            const reservation = await reserveSelfHostedProfileRequestStart(
                input.client,
                minIntervalMs,
                options,
                input.wallNow
            );
            const rpcElapsedMs = now() - rpcStartedAt;
            if (
                !Number.isFinite(rpcElapsedMs)
                || rpcElapsedMs < 0
                || rpcElapsedMs > options.responseGuardMs
            ) {
                throw coordinationError();
            }
            const sleepStartedAt = now();
            let sleepElapsedMs = 0;
            let remainingWaitMs = reservation.waitMs;
            for (let sleepAttempt = 0; remainingWaitMs > 0; sleepAttempt++) {
                if (sleepAttempt >= 16) throw coordinationError();
                const beforeSleep = now();
                await sleep(remainingWaitMs);
                const afterSleep = now();
                if (
                    !Number.isFinite(afterSleep)
                    || afterSleep <= beforeSleep
                    || afterSleep < sleepStartedAt
                ) {
                    throw coordinationError();
                }
                sleepElapsedMs = afterSleep - sleepStartedAt;
                remainingWaitMs = Math.max(0, reservation.waitMs - sleepElapsedMs);
            }
            const positiveSleepOvershootMs = Math.max(
                0,
                sleepElapsedMs - reservation.waitMs
            );
            if (rpcElapsedMs + positiveSleepOvershootMs > options.responseGuardMs) {
                throw coordinationError();
            }
            return reservation;
        },
    };
}
