import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
} from './v2-coordinator';
import {
    ANALYSIS_V2_FINALIZE_JOB_KEY,
    buildAnalysisV2DagPlan,
    type AnalysisV2DagRelationshipManifest,
    type AnalysisV2DagState,
} from './v2-dag-planner';
import type { AnalysisV2DagStateStore } from './v2-dag-state-store';
import type {
    AnalysisV2JobStore,
    ClaimedAnalysisV2Job,
} from './v2-job-store';
import {
    AnalysisV2JobExecutionError,
    executeAnalysisV2FoundationJob,
    processAnalysisV2TaskDelivery,
    type AnalysisV2StageExecutorRegistry,
} from './v2-worker';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const reservationToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const claimToken = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const delivery = {
    requestId,
    jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    generation: 1,
    reservationToken,
};
const bootstrapClaim: ClaimedAnalysisV2Job = {
    ...delivery,
    track: 'coordinator',
    kind: 'bootstrap',
    batch: null,
    inputHash: analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY),
    claimToken,
    attemptCount: 1,
};

function digest(label: string): string {
    return createHash('sha256').update(label, 'utf8').digest('hex');
}

function baseState(): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: digest('request'),
        planId: 'basic',
        planSnapshotHash: digest('plan'),
        girlfriendExclusion: {
            decisionHash: digest('girlfriend-exclusion'),
            excludedCount: 1,
        },
    };
}

function relationshipManifest(): AnalysisV2DagRelationshipManifest {
    return {
        revision: 1,
        resultHash: digest('relationships'),
        detectedMutualCount: 32,
        publicCount: 31,
        privateCount: 1,
        detailedSelectedPublicCount: 31,
        notScreenedPublicCount: 0,
        profileBatches: [
            { batch: 0, itemCount: 30, inputHash: digest('profile-topology:0') },
            { batch: 1, itemCount: 1, inputHash: digest('profile-topology:1') },
        ],
        privateNameBatches: [
            { batch: 0, itemCount: 1, inputHash: digest('private-topology:0') },
        ],
    };
}

function claimFor(
    state: AnalysisV2DagState,
    jobKey: string,
    overrides: Partial<ClaimedAnalysisV2Job> = {}
): ClaimedAnalysisV2Job {
    const job = buildAnalysisV2DagPlan(requestId, state).jobs
        .find(candidate => candidate.jobKey === jobKey);
    if (!job) throw new Error(`Missing planned job ${jobKey}`);
    return {
        requestId,
        jobKey: job.jobKey,
        track: job.track,
        kind: job.kind,
        batch: job.batch,
        inputHash: job.inputHash,
        generation: 1,
        reservationToken,
        claimToken,
        attemptCount: 1,
        ...overrides,
    };
}

function store(
    claimed: ClaimedAnalysisV2Job = bootstrapClaim,
    overrides: Partial<AnalysisV2JobStore> = {}
): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn(),
        rearmDispatch: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(async () => claimed),
        releaseClaim: vi.fn(async (_claim, failure) => ({
            released: true,
            status: failure?.retryable === false ? 'failed' as const : 'pending' as const,
            attemptCount: 1,
            requestStatus: failure?.retryable === false ? 'failed' : 'processing',
        })),
        completeAndFanout: vi.fn(async () => []),
        listDispatchable: vi.fn(),
        ...overrides,
    };
}

function stateStore(
    state: AnalysisV2DagState | null = baseState(),
    overrides: Partial<AnalysisV2DagStateStore> = {}
): AnalysisV2DagStateStore {
    return {
        initializeScope: vi.fn(async () => {
            if (!state) throw new Error('missing fixture state');
            return state;
        }),
        checkpointManifest: vi.fn(async () => {
            if (!state) throw new Error('missing fixture state');
            return state;
        }),
        load: vi.fn(async () => state),
        ...overrides,
    };
}

describe('analysis V2 durable DAG worker', () => {
    it('initializes bootstrap under its live claim and fans out canonical root jobs', async () => {
        const dagStore = stateStore();
        const jobStore = store(bootstrapClaim, {
            completeAndFanout: vi.fn(async () => [
                { requestId, jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY },
                { requestId, jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY },
            ]),
        });
        const dispatch = vi.fn()
            .mockResolvedValueOnce('enqueued')
            .mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            stateStore: dagStore,
            dispatch,
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 2,
            pendingRecoveryCount: 1,
        });
        expect(dagStore.initializeScope).toHaveBeenCalledWith({
            requestId,
            jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            inputHash: bootstrapClaim.inputHash,
            claimToken,
        });
        expect(jobStore.completeAndFanout).toHaveBeenCalledWith(
            bootstrapClaim,
            expect.arrayContaining([
                expect.objectContaining({ jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY }),
                expect.objectContaining({ jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY }),
            ])
        );
        const successors = vi.mocked(jobStore.completeAndFanout).mock.calls[0][1];
        expect(successors[0].inputHash).not.toBe(
            analysisV2JobInputHash(requestId, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)
        );
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('does not run or fan out an already-terminal delivery', async () => {
        const jobStore = store(bootstrapClaim, { claim: vi.fn(async () => null) });
        const handler = vi.fn();
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
        })).resolves.toEqual({ status: 'already_terminal' });
        expect(handler).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });

    it('rejects a corrupted bootstrap input before initializing durable scope', async () => {
        const dagStore = stateStore();
        await expect(executeAnalysisV2FoundationJob({
            ...bootstrapClaim,
            inputHash: '0'.repeat(64),
        }, { stateStore: dagStore })).rejects.toMatchObject({
            code: 'ANALYSIS_V2_JOB_INPUT_MISMATCH',
            retryable: false,
        });
        expect(dagStore.initializeScope).not.toHaveBeenCalled();
    });

    it('fails a non-bootstrap job when its canonical scope is missing', async () => {
        const initial = baseState();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const jobStore = store(relationshipClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(null),
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_DAG_SCOPE_MISSING',
        });
        expect(jobStore.releaseClaim).toHaveBeenCalledWith(
            relationshipClaim,
            expect.objectContaining({ retryable: false })
        );
    });

    it('retries a known dynamic job whose producer checkpoint is not ready', async () => {
        const notReadyClaim: ClaimedAnalysisV2Job = {
            ...bootstrapClaim,
            jobKey: 'track:profiles:batch:0',
            track: 'profiles',
            kind: 'profile_fetch',
            batch: 0,
            inputHash: digest('not-ready-profile'),
        };
        const jobStore = store(notReadyClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: notReadyClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(),
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY',
        });
        expect(jobStore.releaseClaim).toHaveBeenCalledWith(
            notReadyClaim,
            expect.objectContaining({ retryable: true })
        );
    });

    it('rejects exact input and durable job-definition drift before stage execution', async () => {
        const initial = baseState();
        const canonical = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const executor = vi.fn();
        const executors = { relationships: executor } as AnalysisV2StageExecutorRegistry;

        for (const drifted of [
            { ...canonical, inputHash: digest('drifted-input') },
            { ...canonical, track: 'target_evidence' },
        ]) {
            const jobStore = store(drifted);
            await expect(processAnalysisV2TaskDelivery({
                ...delivery,
                jobKey: drifted.jobKey,
            }, {
                store: jobStore,
                stateStore: stateStore(initial),
                executors,
            })).resolves.toMatchObject({ status: 'failed' });
        }
        expect(executor).not.toHaveBeenCalled();
    });

    it('persists a stage checkpoint, reloads state, and derives dynamic batch fanout', async () => {
        const initial = baseState();
        const manifest = relationshipManifest();
        const completed: AnalysisV2DagState = { ...initial, relationships: manifest };
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        let current = initial;
        const dagStore = stateStore(initial, {
            load: vi.fn(async () => current),
            checkpointManifest: vi.fn(async () => {
                current = completed;
                return current;
            }),
        });
        const executor = vi.fn(async () => ({
            checkpoint: { kind: 'relationships' as const, manifest },
        }));
        const jobStore = store(relationshipClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: dagStore,
            executors: { relationships: executor },
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 0,
            pendingRecoveryCount: 0,
        });
        expect(executor).toHaveBeenCalledWith(expect.objectContaining({
            stage: 'relationships',
            claim: relationshipClaim,
            state: initial,
        }));
        expect(dagStore.checkpointManifest).toHaveBeenCalledWith(
            relationshipClaim,
            { kind: 'relationships', manifest }
        );
        expect(dagStore.load).toHaveBeenCalledTimes(2);
        const fanout = vi.mocked(jobStore.completeAndFanout).mock.calls[0][1];
        expect(fanout.map(job => job.jobKey)).toEqual([
            'track:profiles:batch:0',
            'track:profiles:batch:1',
            'track:private-names:batch:0',
        ]);
        expect(fanout.every(job => job.requiredJobKeys?.includes(relationshipClaim.jobKey)))
            .toBe(true);
    });

    it('replays a persisted checkpoint without repeating provider work after completion failure', async () => {
        const initial = baseState();
        const manifest = relationshipManifest();
        const completed: AnalysisV2DagState = { ...initial, relationships: manifest };
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        let current = initial;
        const dagStore = stateStore(initial, {
            load: vi.fn(async () => current),
            checkpointManifest: vi.fn(async () => {
                current = completed;
                return current;
            }),
        });
        const executor = vi.fn(async () => ({
            checkpoint: { kind: 'relationships' as const, manifest },
        }));
        const completeAndFanout = vi.fn()
            .mockRejectedValueOnce(new Error('completion RPC unavailable'))
            .mockResolvedValueOnce([]);
        const jobStore = store(relationshipClaim, { completeAndFanout });
        const input = {
            store: jobStore,
            stateStore: dagStore,
            executors: { relationships: executor },
        };
        const relationshipDelivery = { ...delivery, jobKey: relationshipClaim.jobKey };

        await expect(processAnalysisV2TaskDelivery(relationshipDelivery, input))
            .rejects.toThrow('completion RPC unavailable');
        await expect(processAnalysisV2TaskDelivery(relationshipDelivery, input))
            .resolves.toMatchObject({ status: 'completed' });

        expect(executor).toHaveBeenCalledOnce();
        expect(dagStore.checkpointManifest).toHaveBeenCalledOnce();
        expect(completeAndFanout).toHaveBeenCalledTimes(2);
        expect(completeAndFanout).toHaveBeenLastCalledWith(
            relationshipClaim,
            expect.arrayContaining([
                expect.objectContaining({ jobKey: 'track:profiles:batch:0' }),
            ])
        );
    });

    it('fails closed when a concrete stage has no registered executor', async () => {
        const initial = baseState();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const jobStore = store(relationshipClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(initial),
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE',
        });
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });

    it('classifies transient checkpoint persistence and explicit provider failures as retryable', async () => {
        const initial = baseState();
        const manifest = relationshipManifest();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const persistenceStore = stateStore(initial, {
            checkpointManifest: vi.fn(async () => {
                throw new Error('ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR: unavailable.');
            }),
        });
        const executor = vi.fn(async () => ({
            checkpoint: { kind: 'relationships' as const, manifest },
        }));

        const persistenceJobStore = store(relationshipClaim);
        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: persistenceJobStore,
            stateStore: persistenceStore,
            executors: { relationships: executor },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR',
        });

        const providerJobStore = store(relationshipClaim);
        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: providerJobStore,
            stateStore: stateStore(initial),
            executors: {
                relationships: async () => {
                    throw new AnalysisV2JobExecutionError('PROVIDER_RATE_LIMITED', true);
                },
            },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'PROVIDER_RATE_LIMITED',
        });
        expect(providerJobStore.releaseClaim).toHaveBeenCalledWith(
            relationshipClaim,
            { errorCode: 'PROVIDER_RATE_LIMITED', retryable: true }
        );
    });

    it('completes an idempotent finalizer with no DAG checkpoint or successor', async () => {
        const completeState: AnalysisV2DagState = {
            ...baseState(),
            relationships: {
                revision: 1,
                resultHash: digest('empty-relationships'),
                detectedMutualCount: 0,
                publicCount: 0,
                privateCount: 0,
                detailedSelectedPublicCount: 0,
                notScreenedPublicCount: 0,
                profileBatches: [],
                privateNameBatches: [],
            },
            targetEvidence: {
                revision: 1,
                resultHash: digest('empty-target-evidence'),
                interactorCount: 0,
            },
            primaryJoin: {
                revision: 1,
                resultHash: digest('empty-primary-join'),
                verifiedFemaleCount: 0,
            },
            screening: {
                revision: 1,
                resultHash: digest('empty-screening'),
                verifiedFemaleCount: 0,
                shortlistCount: 0,
                shortlistHash: digest('empty-shortlist'),
            },
            reverseLikes: {
                revision: 1,
                resultHash: digest('empty-reverse-likes'),
                shortlistCount: 0,
            },
            partnerSafety: {
                revision: 1,
                resultHash: digest('empty-partner-safety'),
                shortlistCount: 0,
            },
            finalScore: {
                revision: 1,
                resultHash: digest('empty-final-score'),
                featuredHighRiskCount: 0,
                narrativeCount: 0,
                narrativeBatchHash: digest('empty-narrative-batch'),
            },
            narrative: {
                revision: 1,
                resultHash: digest('empty-narrative'),
                narrativeCount: 0,
            },
        };
        const finalizerClaim = claimFor(completeState, ANALYSIS_V2_FINALIZE_JOB_KEY);
        const dagStore = stateStore(completeState);
        const finalizer = vi.fn(async () => ({ checkpoint: null }));
        const jobStore = store(finalizerClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: finalizerClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: dagStore,
            executors: { finalize: finalizer },
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 0,
            pendingRecoveryCount: 0,
        });
        expect(finalizer).toHaveBeenCalledOnce();
        expect(dagStore.checkpointManifest).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).toHaveBeenCalledWith(finalizerClaim, []);
    });

    it('keeps legacy injected handler failures behind the same release semantics', async () => {
        const jobStore = store(bootstrapClaim);
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('provider detail');
            },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });
});
