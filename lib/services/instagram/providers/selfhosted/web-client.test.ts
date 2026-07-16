import { describe, expect, it, vi } from 'vitest';
import { createRequestStartGate } from './rate-limit';
import {
    createSelfHostedProfileGlobalGate,
    type SelfHostedProfileGlobalGate,
    type SelfHostedProfileGlobalGateRpcClient,
} from './global-request-gate';
import {
    classifyWebProfileFailure,
    createSharedWebProfileFetchers,
    createWebProfileCircuitBreaker,
    getWebProfileConfig,
    makeWebProfileAdmissionFetcher,
    makeWebProfileFetcher,
} from './web-client';

function response(payload: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(payload), { status, headers });
}

function env(overrides: Record<string, string> = {}) {
    return {
        SELFHOSTED_PROFILE_TIMEOUT_MS: '1000',
        SELFHOSTED_PROFILE_RETRIES: '0',
        SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS: '0',
        SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '0',
        SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS: '1000',
        SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD: '2',
        SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '3',
        SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS: '60000',
        ...overrides,
    };
}

function rawUser(username: string) {
    return {
        username,
        is_private: false,
        is_verified: false,
        edge_followed_by: { count: 1 },
        edge_follow: { count: 1 },
        edge_owner_to_timeline_media: { count: 0, edges: [] },
    };
}

describe('selfhosted web profile client', () => {
    it('keeps the default cold-profile start schedule within two minutes', () => {
        const config = getWebProfileConfig({});
        expect(config.minIntervalMs).toBe(300);
        expect((350 - 1) * config.minIntervalMs).toBeLessThan(120_000);
    });

    it('returns null only for HTTP 404 or an explicit data.user=null', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 404))
            .mockResolvedValueOnce(response({ data: { user: null } }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('missing_one')).resolves.toBeNull();
        await expect(fetchProfile('missing_two')).resolves.toBeNull();
    });

    it('rejects an unexpected successful response schema', async () => {
        const fetchProfile = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: {} })),
        });

        await expect(fetchProfile('target')).rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('honors Retry-After for a bounded 429 retry while other calls see the circuit', async () => {
        let clock = 0;
        const waits: number[] = [];
        const wait = async (ms: number) => {
            waits.push(ms);
            clock += ms;
        };
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 429, { 'retry-after': '2' }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('target') } }));
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_RETRIES: '1' }),
            fetchFn,
            now: () => clock,
            sleep: wait,
            gate: createRequestStartGate(() => clock, wait),
            circuit: createWebProfileCircuitBreaker(() => clock),
        });

        await expect(fetchProfile('target')).resolves.toMatchObject({ username: 'target' });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(waits).toContain(2_000);
    });

    it('opens immediately after a terminal 429 and fails the next call before fetch', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({}, 429));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('first')).rejects.toThrow('rate limited');
        await expect(fetchProfile('second')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('exposes only bounded routing metadata for an empty text/plain 429', async () => {
        const fetchProfile = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => new Response('', {
                status: 429,
                headers: { 'content-type': 'text/plain' },
            })),
        });

        const error = await fetchProfile('target').catch(caught => caught);

        expect(classifyWebProfileFailure(error)).toEqual({
            kind: 'rate_limit',
            retryable: true,
            httpStatus: 429,
        });
        expect(Object.keys(classifyWebProfileFailure(error) ?? {})).toEqual([
            'kind',
            'retryable',
            'httpStatus',
        ]);
        expect(classifyWebProfileFailure(new Error('target raw response'))).toBeNull();
    });

    it('opens after the configured successful-response schema burst threshold', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({ data: {} }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('first')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('second')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('third')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('opens after a bounded burst of retryable provider outages', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({}, 503));
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '2' }),
            fetchFn,
        });

        await expect(fetchProfile('first')).rejects.toThrow('HTTP 503');
        await expect(fetchProfile('second')).rejects.toThrow('HTTP 503');
        await expect(fetchProfile('third')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('counts a malformed raw profile contract and username mismatch as schema failures', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({ data: { user: { username: 'target' } } }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('other') } }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('target')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('target')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('target')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('keeps fresh admission independent from timeline, verification, and URL fields', async () => {
        const minimalUser = {
            username: 'target',
            is_private: false,
            edge_followed_by: { count: 401 },
            edge_follow: { count: 399 },
            edge_owner_to_timeline_media: { count: 'changed' },
            is_verified: 'changed',
            profile_pic_url: 'not a url',
        };
        const admissionFetcher = makeWebProfileAdmissionFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: { user: minimalUser } })),
        });
        const fullFetcher = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: { user: minimalUser } })),
        });

        await expect(admissionFetcher('target')).resolves.toMatchObject({
            username: 'target',
            edge_followed_by: { count: 401 },
            edge_follow: { count: 399 },
        });
        await expect(fullFetcher('target')).rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('rejects invalid reliability settings before making a request', () => {
        expect(() => getWebProfileConfig({ SELFHOSTED_PROFILE_RETRIES: 'unbounded' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });

    it('reserves globally and waits before usage accounting or the network request', async () => {
        const order: string[] = [];
        const client: SelfHostedProfileGlobalGateRpcClient = {
            rpc: vi.fn(async (_name, params) => {
                order.push(`reserve:${params.p_min_interval_ms}`);
                return {
                    data: {
                        schemaVersion: 1,
                        waitMs: 40,
                        reservedAt: '2026-07-16T12:34:56.789+00:00',
                    },
                    error: null,
                };
            }),
        };
        const globalGate = createSelfHostedProfileGlobalGate({
            client,
            sleep: async ms => {
                order.push(`wait:${ms}`);
            },
        });
        const fetchProfile = makeWebProfileFetcher({
            env: env({
                SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true',
                SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: '750',
            }),
            globalGate,
            fetchFn: vi.fn<typeof fetch>(async () => {
                order.push('fetch');
                return response({ data: { user: rawUser('target') } });
            }),
        });

        await fetchProfile('target', undefined, {
            onRequest: () => order.push('onRequest'),
        });

        expect(order).toEqual(['reserve:750', 'wait:40', 'onRequest', 'fetch']);
    });

    it('bypasses the global RPC completely when the gate is disabled', async () => {
        const globalGate: SelfHostedProfileGlobalGate = {
            reserveAndWait: vi.fn(async () => {
                throw new Error('must not run');
            }),
        };
        const circuit = {
            assertAvailable: vi.fn(),
            recordSuccess: vi.fn(),
            recordFailure: vi.fn(),
        };
        const fetchFn = vi.fn<typeof fetch>(async () =>
            response({ data: { user: rawUser('target') } })
        );
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'false' }),
            globalGate,
            circuit,
            fetchFn,
        });

        await expect(fetchProfile('target')).resolves.toMatchObject({ username: 'target' });
        expect(globalGate.reserveAndWait).not.toHaveBeenCalled();
        expect(circuit.assertAvailable).toHaveBeenCalledTimes(2);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('classifies coordination failure as retryable transport without a network start', async () => {
        const globalGate: SelfHostedProfileGlobalGate = {
            reserveAndWait: vi.fn(async () => {
                throw new Error('raw database endpoint and credential');
            }),
        };
        const fetchFn = vi.fn<typeof fetch>();
        const onRequest = vi.fn();
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            fetchFn,
        });

        const error = await fetchProfile('target', undefined, { onRequest })
            .catch(caught => caught);

        expect(classifyWebProfileFailure(error)).toEqual({
            kind: 'transport',
            retryable: true,
            httpStatus: null,
        });
        expect((error as Error).message).not.toContain('database endpoint');
        expect(onRequest).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('rechecks the process-local circuit after the global wait', async () => {
        let circuitOpen = false;
        const circuit = {
            assertAvailable: vi.fn(() => {
                if (circuitOpen) throw new Error('circuit opened while globally queued');
            }),
            recordSuccess: vi.fn(),
            recordFailure: vi.fn(),
        };
        const globalGate: SelfHostedProfileGlobalGate = {
            reserveAndWait: vi.fn(async () => {
                circuitOpen = true;
                return {
                    schemaVersion: 1 as const,
                    waitMs: 0,
                    reservedAt: '2026-07-16T12:34:56.789+00:00',
                };
            }),
        };
        const fetchFn = vi.fn<typeof fetch>();
        const onRequest = vi.fn();
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            circuit,
            fetchFn,
        });

        await expect(fetchProfile('target', undefined, { onRequest })).rejects.toThrow();
        expect(circuit.assertAvailable).toHaveBeenCalledTimes(3);
        expect(onRequest).not.toHaveBeenCalled();
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('builds the default full and admission fetchers around one shared global gate', async () => {
        const globalGate: SelfHostedProfileGlobalGate = {
            reserveAndWait: vi.fn(async () => ({
                schemaVersion: 1 as const,
                waitMs: 0,
                reservedAt: '2026-07-16T12:34:56.789+00:00',
            })),
        };
        const fetchFn = vi.fn<typeof fetch>(async () =>
            response({ data: { user: rawUser('target') } })
        );
        const fetchers = createSharedWebProfileFetchers({
            env: env({ SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: 'true' }),
            globalGate,
            fetchFn,
        });

        await fetchers.full('target');
        await fetchers.admission('target');

        expect(globalGate.reserveAndWait).toHaveBeenCalledTimes(2);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
});
