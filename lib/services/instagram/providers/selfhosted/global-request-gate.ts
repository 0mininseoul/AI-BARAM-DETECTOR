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

export interface SelfHostedProfileGlobalGateRpcClient {
    rpc(
        name: typeof SELFHOSTED_PROFILE_GLOBAL_GATE_RPC,
        params: { p_min_interval_ms: number }
    ): PromiseLike<RpcResult>;
}

export interface SelfHostedProfileGlobalGateConfig {
    enabled: boolean;
    minIntervalMs: number;
}

export interface SelfHostedProfileGlobalGate {
    reserveAndWait(minIntervalMs: number): Promise<SelfHostedProfileRequestStartReservation>;
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

export function getSelfHostedProfileGlobalGateConfig(
    env: Record<string, string | undefined> = process.env
): SelfHostedProfileGlobalGateConfig {
    return {
        enabled: enabledSetting(env),
        minIntervalMs: intervalSetting(env),
    };
}

export async function reserveSelfHostedProfileRequestStart(
    client: SelfHostedProfileGlobalGateRpcClient,
    minIntervalMs: number
): Promise<SelfHostedProfileRequestStartReservation> {
    try {
        const result = await client.rpc(SELFHOSTED_PROFILE_GLOBAL_GATE_RPC, {
            p_min_interval_ms: minIntervalMs,
        });
        if (result.error !== null) throw coordinationError();
        const parsed = reservationSchema.safeParse(result.data);
        if (!parsed.success) throw coordinationError();
        return parsed.data;
    } catch {
        throw coordinationError();
    }
}

export function createSelfHostedProfileGlobalGate(input: {
    client: SelfHostedProfileGlobalGateRpcClient;
    sleep?: (ms: number) => Promise<void>;
}): SelfHostedProfileGlobalGate {
    const sleep = input.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    return {
        async reserveAndWait(minIntervalMs) {
            const reservation = await reserveSelfHostedProfileRequestStart(
                input.client,
                minIntervalMs
            );
            if (reservation.waitMs > 0) await sleep(reservation.waitMs);
            return reservation;
        },
    };
}
