import { describe, expect, it, vi } from 'vitest';
import {
    SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS,
    SELFHOSTED_PROFILE_GLOBAL_GATE_RPC,
    createSelfHostedProfileGlobalGate,
    getSelfHostedProfileGlobalGateConfig,
    reserveSelfHostedProfileRequestStart,
    type SelfHostedProfileGlobalGateRpcClient,
} from './global-request-gate';

const validReservation = {
    schemaVersion: 1,
    waitMs: 125,
    reservedAt: '2026-07-16T12:34:56.789+00:00',
};

function fakeClient(result: { data: unknown; error: unknown }) {
    const rpc = vi.fn(async () => result);
    return {
        client: { rpc } as SelfHostedProfileGlobalGateRpcClient,
        rpc,
    };
}

describe('selfhosted production-wide profile request gate config', () => {
    it('defaults on only in production with a 750ms aggregate interval', () => {
        expect(getSelfHostedProfileGlobalGateConfig({ NODE_ENV: 'production' })).toEqual({
            enabled: true,
            minIntervalMs: 750,
        });
        expect(getSelfHostedProfileGlobalGateConfig({ NODE_ENV: 'development' })).toEqual({
            enabled: false,
            minIntervalMs: 750,
        });
        expect(getSelfHostedProfileGlobalGateConfig({})).toEqual({
            enabled: false,
            minIntervalMs: 750,
        });
    });

    it('lets explicit true or false override the environment default', () => {
        expect(getSelfHostedProfileGlobalGateConfig({
            NODE_ENV: 'development',
            SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
        }).enabled).toBe(true);
        expect(getSelfHostedProfileGlobalGateConfig({
            NODE_ENV: 'production',
            SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false',
        }).enabled).toBe(false);
    });

    it('rejects ambiguous booleans and out-of-range or non-integer intervals', () => {
        expect(() => getSelfHostedProfileGlobalGateConfig({
            SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: '1',
        })).toThrow('SCRAPING_CONFIG_ERROR');
        for (const value of ['249', '60001', '750.5', 'not-a-number']) {
            expect(() => getSelfHostedProfileGlobalGateConfig({
                SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: value,
            })).toThrow('SCRAPING_CONFIG_ERROR');
        }
        expect(getSelfHostedProfileGlobalGateConfig({
            SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: '250',
        }).minIntervalMs).toBe(250);
        expect(getSelfHostedProfileGlobalGateConfig({
            SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: '60000',
        }).minIntervalMs).toBe(60_000);
    });
});

describe('selfhosted production-wide profile request reservation', () => {
    it('calls the exact RPC and accepts only its strict versioned result', async () => {
        const { client, rpc } = fakeClient({ data: validReservation, error: null });

        await expect(reserveSelfHostedProfileRequestStart(client, 750))
            .resolves.toEqual(validReservation);
        expect(rpc).toHaveBeenCalledWith(SELFHOSTED_PROFILE_GLOBAL_GATE_RPC, {
            p_min_interval_ms: 750,
        });
    });

    it.each([
        null,
        [],
        { ...validReservation, schemaVersion: 2 },
        { ...validReservation, waitMs: -1 },
        { ...validReservation, waitMs: 1.5 },
        { ...validReservation, waitMs: SELFHOSTED_PROFILE_GLOBAL_GATE_MAX_WAIT_MS + 1 },
        { ...validReservation, reservedAt: 'not-a-timestamp' },
        { ...validReservation, unexpected: true },
    ])('fails closed on a malformed RPC result %#', async (data) => {
        const { client } = fakeClient({ data, error: null });

        await expect(reserveSelfHostedProfileRequestStart(client, 750)).rejects.toThrow(
            'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
        );
    });

    it('sanitizes returned and thrown RPC errors', async () => {
        const returned = fakeClient({
            data: null,
            error: { message: 'database-host-and-secret-detail' },
        });
        await expect(reserveSelfHostedProfileRequestStart(returned.client, 750))
            .rejects.toThrow(
                'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
            );

        const falseyError = fakeClient({ data: validReservation, error: '' });
        await expect(reserveSelfHostedProfileRequestStart(falseyError.client, 750))
            .rejects.toThrow(
                'SELFHOSTED_PROFILE_COORDINATION_ERROR: global request-start reservation failed.'
            );

        const thrown: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(async () => {
                throw new Error('raw connection string');
            }),
        };
        const error = await reserveSelfHostedProfileRequestStart(thrown, 750)
            .catch(caught => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain('connection string');
    });

    it('reserves first and waits exactly the returned delay', async () => {
        const order: string[] = [];
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(async () => {
                order.push('reserve');
                return { data: validReservation, error: null };
            }),
        };
        const gate = createSelfHostedProfileGlobalGate({
            client,
            sleep: async (ms) => {
                order.push(`wait:${ms}`);
            },
        });

        await expect(gate.reserveAndWait(750)).resolves.toEqual(validReservation);
        expect(order).toEqual(['reserve', 'wait:125']);
    });
});
