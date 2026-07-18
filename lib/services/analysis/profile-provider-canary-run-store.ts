import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    isApifyCredentialSlot,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';

export const PROFILE_PROVIDER_CANARY_VERSION =
    'profile-fallback-replacement-canary-v1' as const;
export const PROFILE_PROVIDER_CANARY_ACTOR = Object.freeze({
    actorId: 'apify/instagram-scraper' as const,
    build: '0.0.692' as const,
    inputContractVersion: 1 as const,
    outputContractVersion: 1 as const,
});
export const PROFILE_PROVIDER_CANARY_REQUESTED_COUNT = 15 as const;
export const PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD = 0.05 as const;
export const PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD = 1 as const;

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const PROFILE_PROVIDER_CANARY_DATABASE_NAMES = Object.freeze({
    sourceRpc: 'load_analysis_v2_profile_provider_canary_source',
    loadExperimentRpc: 'load_analysis_v2_profile_provider_canary_experiment',
    loadRunRpc: 'load_analysis_v2_profile_provider_canary_run',
    reserveRpc: 'reserve_analysis_v2_profile_provider_canary_run',
    checkpointStartedRpc: 'checkpoint_analysis_v2_profile_provider_canary_run_started',
    markAmbiguousRpc: 'mark_analysis_v2_profile_provider_canary_run_ambiguous',
    terminalizeRpc: 'terminalize_analysis_v2_profile_provider_canary_run',
    reconcileUsageRpc: 'reconcile_analysis_v2_profile_provider_canary_run_usage',
    markRunStorageCleanRpc: 'mark_analysis_v2_profile_provider_canary_run_storage_clean',
    beginTerminalizationRpc: 'begin_analysis_v2_profile_provider_canary_terminalization',
    claimExpiredCleanupRpc: 'claim_expired_analysis_v2_profile_provider_canary_cleanup',
    loadCleanupInventoryRpc: 'load_analysis_v2_profile_provider_canary_cleanup_inventory',
    markSourceStorageCleanRpc: 'mark_analysis_v2_profile_provider_canary_source_storage_clean',
    completeCleanupRpc: 'complete_analysis_v2_profile_provider_canary_cleanup',
});

export type ProfileProviderCanaryRepetition = 1 | 2;
export type ProfileProviderCanaryStorage = 'kvs' | 'dataset' | 'request_queue';
export type ProfileProviderCanaryTerminalReason =
    | 'strict_failure'
    | 'verified_no_run'
    | 'completed'
    | 'aborted_by_operator'
    | 'expired_waiting_for_repetition';

export interface ProfileProviderCanarySourceProof {
    sourceRunCount: 8;
    candidateCount: 15;
    uniqueCandidateCount: 15;
    publicCandidateCount: 15;
    incompleteCandidateCount: 15;
    unavailableCandidateCount: 0;
    primarySuccessCandidateCount: 0;
    criticalCandidateCount: 3;
}

export interface StoredProfileProviderCanaryExperiment extends ProfileProviderCanarySourceProof {
    sourceRequestId: string;
    canaryVersion: typeof PROFILE_PROVIDER_CANARY_VERSION;
    orderedSetHmac: string | null;
    state: 'active' | 'awaiting_repetition_2' | 'terminalizing' | 'experiment_terminal';
    terminalReason: ProfileProviderCanaryTerminalReason | null;
    rep2ApprovalDeadlineAt: string | null;
    sourceKvsCleanupState: 'pending' | 'verified_absent';
    sourceDatasetCleanupState: 'pending' | 'verified_absent';
    sourceRequestQueueCleanupState: 'pending' | 'verified_absent';
    sourceKvsCleanedAt: string | null;
    sourceDatasetCleanedAt: string | null;
    sourceRequestQueueCleanedAt: string | null;
    cleanupClaimToken: string | null;
    cleanupClaimedAt: string | null;
    cleanupLeaseExpiresAt: string | null;
    hmacClearedAt: string | null;
    experimentTerminalAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface StoredProfileProviderCanaryRun {
    sourceRequestId: string;
    canaryVersion: typeof PROFILE_PROVIDER_CANARY_VERSION;
    repetition: ProfileProviderCanaryRepetition;
    actorId: typeof PROFILE_PROVIDER_CANARY_ACTOR.actorId;
    actorBuild: typeof PROFILE_PROVIDER_CANARY_ACTOR.build;
    inputContractVersion: 1;
    outputContractVersion: 1;
    credentialSlot: 'primary';
    requestedCount: 15;
    maxChargeUsd: 0.05;
    reservationToken: string;
    state: 'starting' | 'ambiguous' | 'running' | 'succeeded' | 'failed' | 'verified_no_run';
    runId: string | null;
    terminalCount: number | null;
    successCount: number | null;
    unavailableCount: number | null;
    incompleteCount: number | null;
    otherFailureCount: number | null;
    criticalSuccessCount: number | null;
    latencyMs: number | null;
    buildVerified: boolean | null;
    restrictedAccessVerified: boolean;
    gatePassed: boolean | null;
    actualUsageUsd: number | null;
    costStatus: 'actual' | 'conservative' | 'unknown';
    kvsCleanupState: 'pending' | 'verified_absent' | 'not_applicable';
    datasetCleanupState: 'pending' | 'verified_absent' | 'not_applicable';
    requestQueueCleanupState: 'pending' | 'verified_absent' | 'not_applicable';
    kvsCleanedAt: string | null;
    datasetCleanedAt: string | null;
    requestQueueCleanedAt: string | null;
    resolutionKind: 'none' | 'adopted_run' | 'verified_no_run';
    resolutionEvidenceHash: string | null;
    reservedAt: string;
    runStartedAt: string | null;
    ambiguousAt: string | null;
    resolvedAt: string | null;
    terminalizedAt: string | null;
    usageReconciledAt: string | null;
    cleanupCompletedAt: string | null;
    updatedAt: string;
}

export interface ProfileProviderCanaryCleanupInventory {
    sourceRequestId: string;
    sourceRuns: Array<{ runId: string; credentialSlot: ApifyCredentialSlot }>;
    canaryRuns: Array<{
        repetition: ProfileProviderCanaryRepetition;
        runId: string;
        credentialSlot: 'primary';
        reservationToken: string;
    }>;
}

interface RunKey {
    sourceRequestId: string;
    repetition: ProfileProviderCanaryRepetition;
}
interface ReservedRunKey extends RunKey { reservationToken: string }

export interface ProfileProviderCanaryRunStore {
    loadSource(input: { sourceRequestId: string; ownerId: string; ownerEmail: string }): Promise<unknown>;
    loadExperiment(input: Pick<RunKey, 'sourceRequestId'>):
        Promise<StoredProfileProviderCanaryExperiment | null>;
    loadRun(input: RunKey): Promise<StoredProfileProviderCanaryRun | null>;
    reserve(input: RunKey & ProfileProviderCanarySourceProof & {
        orderedSetHmac: string;
        restrictedAccessVerified: boolean;
    }): Promise<{
        created: boolean;
        experiment: StoredProfileProviderCanaryExperiment;
        run: StoredProfileProviderCanaryRun;
    }>;
    checkpointStarted(input: ReservedRunKey & { runId: string }):
        Promise<StoredProfileProviderCanaryRun>;
    markAmbiguous(input: ReservedRunKey): Promise<StoredProfileProviderCanaryRun>;
    terminalize(input: ReservedRunKey & {
        runId: string;
        terminalCount: number;
        successCount: number;
        unavailableCount: number;
        incompleteCount: number;
        otherFailureCount: number;
        criticalSuccessCount: number;
        latencyMs: number;
        buildVerified: boolean;
        restrictedAccessVerified: boolean;
    }): Promise<StoredProfileProviderCanaryRun>;
    reconcileUsage(input: ReservedRunKey & { runId: string; actualUsageUsd: number }):
        Promise<StoredProfileProviderCanaryRun>;
    markRunStorageClean(input: ReservedRunKey & {
        runId: string;
        storage: ProfileProviderCanaryStorage;
    }): Promise<StoredProfileProviderCanaryRun>;
    beginTerminalization(input: {
        sourceRequestId: string;
        reason: ProfileProviderCanaryTerminalReason;
    }): Promise<StoredProfileProviderCanaryExperiment>;
    claimExpiredForCleanup(input?: { limit?: number }):
        Promise<StoredProfileProviderCanaryExperiment[]>;
    loadCleanupInventory(input: { sourceRequestId: string; cleanupClaimToken: string }):
        Promise<ProfileProviderCanaryCleanupInventory>;
    markSourceStorageClean(input: {
        sourceRequestId: string;
        cleanupClaimToken: string;
        storage: ProfileProviderCanaryStorage;
    }): Promise<StoredProfileProviderCanaryExperiment>;
    completeExperimentCleanup(input: {
        sourceRequestId: string;
        cleanupClaimToken: string;
    }): Promise<StoredProfileProviderCanaryExperiment>;
}

interface RpcResult { data: unknown; error: { code?: string; message?: string } | null }
export interface ProfileProviderCanarySupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

function validationError(): never {
    throw new Error('PROFILE_PROVIDER_CANARY_RUN_VALIDATION_ERROR');
}
function persistenceError(): never {
    throw new Error('PROFILE_PROVIDER_CANARY_RUN_PERSISTENCE_ERROR');
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function uuid(value: string): string {
    if (!UUID_PATTERN.test(value)) validationError();
    return value.toLowerCase();
}
function hmac(value: string): string {
    if (!SHA256_PATTERN.test(value)) validationError();
    return value;
}
function runId(value: string): string {
    if (!RUN_ID_PATTERN.test(value)) validationError();
    return value;
}
function repetition(value: number): ProfileProviderCanaryRepetition {
    if (value !== 1 && value !== 2) validationError();
    return value;
}
function timestamp(value: unknown, nullable = false): string | null {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)
        || !Number.isFinite(Date.parse(value))) persistenceError();
    return new Date(value).toISOString();
}
function nullableUuid(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) persistenceError();
    return value.toLowerCase();
}
function nullableHash(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) persistenceError();
    return value;
}
function nullableRunId(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) persistenceError();
    return value;
}
function integer(value: unknown, maximum: number, nullable = false): number | null {
    if (nullable && value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
        persistenceError();
    }
    return value as number;
}
function money(
    value: unknown,
    nullable = false,
    maximum: number = PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD
): number | null {
    if (nullable && value === null) return null;
    if (typeof value !== 'number'
        && !(typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value))) {
        persistenceError();
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0
        || parsed > maximum + Number.EPSILON) {
        persistenceError();
    }
    return Number(parsed.toFixed(12));
}

function parseExperiment(value: unknown): StoredProfileProviderCanaryExperiment {
    if (!isRecord(value)) persistenceError();
    const state = value.state;
    const terminalReason = value.terminalReason;
    const cleanupState = ['pending', 'verified_absent'];
    if (!UUID_PATTERN.test(String(value.sourceRequestId ?? ''))
        || value.canaryVersion !== PROFILE_PROVIDER_CANARY_VERSION
        || !['active', 'awaiting_repetition_2', 'terminalizing', 'experiment_terminal']
            .includes(String(state))
        || (terminalReason !== null && ![
            'strict_failure', 'verified_no_run', 'completed',
            'aborted_by_operator', 'expired_waiting_for_repetition',
        ].includes(String(terminalReason)))
        || value.sourceRunCount !== 8
        || value.candidateCount !== 15
        || value.uniqueCandidateCount !== 15
        || value.publicCandidateCount !== 15
        || value.incompleteCandidateCount !== 15
        || value.unavailableCandidateCount !== 0
        || value.primarySuccessCandidateCount !== 0
        || value.criticalCandidateCount !== 3
        || !cleanupState.includes(String(value.sourceKvsCleanupState))
        || !cleanupState.includes(String(value.sourceDatasetCleanupState))
        || !cleanupState.includes(String(value.sourceRequestQueueCleanupState))) {
        persistenceError();
    }
    const orderedSetHmac = nullableHash(value.orderedSetHmac);
    const hmacClearedAt = timestamp(value.hmacClearedAt, true);
    if ((state === 'experiment_terminal') !== (orderedSetHmac === null && hmacClearedAt !== null)) {
        persistenceError();
    }
    return {
        sourceRequestId: String(value.sourceRequestId).toLowerCase(),
        canaryVersion: PROFILE_PROVIDER_CANARY_VERSION,
        orderedSetHmac,
        sourceRunCount: 8,
        candidateCount: 15,
        uniqueCandidateCount: 15,
        publicCandidateCount: 15,
        incompleteCandidateCount: 15,
        unavailableCandidateCount: 0,
        primarySuccessCandidateCount: 0,
        criticalCandidateCount: 3,
        state: state as StoredProfileProviderCanaryExperiment['state'],
        terminalReason: terminalReason as ProfileProviderCanaryTerminalReason | null,
        rep2ApprovalDeadlineAt: timestamp(value.rep2ApprovalDeadlineAt, true),
        sourceKvsCleanupState: value.sourceKvsCleanupState as 'pending' | 'verified_absent',
        sourceDatasetCleanupState: value.sourceDatasetCleanupState as 'pending' | 'verified_absent',
        sourceRequestQueueCleanupState:
            value.sourceRequestQueueCleanupState as 'pending' | 'verified_absent',
        sourceKvsCleanedAt: timestamp(value.sourceKvsCleanedAt, true),
        sourceDatasetCleanedAt: timestamp(value.sourceDatasetCleanedAt, true),
        sourceRequestQueueCleanedAt: timestamp(value.sourceRequestQueueCleanedAt, true),
        cleanupClaimToken: nullableUuid(value.cleanupClaimToken),
        cleanupClaimedAt: timestamp(value.cleanupClaimedAt, true),
        cleanupLeaseExpiresAt: timestamp(value.cleanupLeaseExpiresAt, true),
        hmacClearedAt,
        experimentTerminalAt: timestamp(value.experimentTerminalAt, true),
        createdAt: timestamp(value.createdAt) as string,
        updatedAt: timestamp(value.updatedAt) as string,
    };
}

function parseRun(value: unknown): StoredProfileProviderCanaryRun {
    if (!isRecord(value)) persistenceError();
    const state = value.state;
    const costStatus = value.costStatus;
    const cleanupStates = ['pending', 'verified_absent', 'not_applicable'];
    if (!UUID_PATTERN.test(String(value.sourceRequestId ?? ''))
        || value.canaryVersion !== PROFILE_PROVIDER_CANARY_VERSION
        || (value.repetition !== 1 && value.repetition !== 2)
        || value.actorId !== PROFILE_PROVIDER_CANARY_ACTOR.actorId
        || value.actorBuild !== PROFILE_PROVIDER_CANARY_ACTOR.build
        || value.inputContractVersion !== 1 || value.outputContractVersion !== 1
        || value.credentialSlot !== 'primary'
        || value.requestedCount !== 15
        || !['starting', 'ambiguous', 'running', 'succeeded', 'failed', 'verified_no_run']
            .includes(String(state))
        || !['actual', 'conservative', 'unknown'].includes(String(costStatus))
        || !cleanupStates.includes(String(value.kvsCleanupState))
        || !cleanupStates.includes(String(value.datasetCleanupState))
        || !cleanupStates.includes(String(value.requestQueueCleanupState))
        || typeof value.restrictedAccessVerified !== 'boolean') persistenceError();
    if (money(value.maxChargeUsd, false, PROFILE_PROVIDER_CANARY_MAX_CHARGE_USD) !== 0.05) {
        persistenceError();
    }
    const parsed: StoredProfileProviderCanaryRun = {
        sourceRequestId: String(value.sourceRequestId).toLowerCase(),
        canaryVersion: PROFILE_PROVIDER_CANARY_VERSION,
        repetition: value.repetition as ProfileProviderCanaryRepetition,
        actorId: PROFILE_PROVIDER_CANARY_ACTOR.actorId,
        actorBuild: PROFILE_PROVIDER_CANARY_ACTOR.build,
        inputContractVersion: 1,
        outputContractVersion: 1,
        credentialSlot: 'primary',
        requestedCount: 15,
        maxChargeUsd: 0.05,
        reservationToken: nullableUuid(value.reservationToken) ?? persistenceError(),
        state: state as StoredProfileProviderCanaryRun['state'],
        runId: nullableRunId(value.runId),
        terminalCount: integer(value.terminalCount, 15, true),
        successCount: integer(value.successCount, 15, true),
        unavailableCount: integer(value.unavailableCount, 15, true),
        incompleteCount: integer(value.incompleteCount, 15, true),
        otherFailureCount: integer(value.otherFailureCount, 15, true),
        criticalSuccessCount: integer(value.criticalSuccessCount, 3, true),
        latencyMs: integer(value.latencyMs, 300_000, true),
        buildVerified: value.buildVerified === null
            ? null
            : typeof value.buildVerified === 'boolean' ? value.buildVerified : persistenceError(),
        restrictedAccessVerified: value.restrictedAccessVerified,
        gatePassed: value.gatePassed === null
            ? null
            : typeof value.gatePassed === 'boolean' ? value.gatePassed : persistenceError(),
        actualUsageUsd: money(
            value.actualUsageUsd, true, PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD
        ),
        costStatus: costStatus as StoredProfileProviderCanaryRun['costStatus'],
        kvsCleanupState: value.kvsCleanupState as StoredProfileProviderCanaryRun['kvsCleanupState'],
        datasetCleanupState:
            value.datasetCleanupState as StoredProfileProviderCanaryRun['datasetCleanupState'],
        requestQueueCleanupState:
            value.requestQueueCleanupState as StoredProfileProviderCanaryRun['requestQueueCleanupState'],
        kvsCleanedAt: timestamp(value.kvsCleanedAt, true),
        datasetCleanedAt: timestamp(value.datasetCleanedAt, true),
        requestQueueCleanedAt: timestamp(value.requestQueueCleanedAt, true),
        resolutionKind: value.resolutionKind as StoredProfileProviderCanaryRun['resolutionKind'],
        resolutionEvidenceHash: nullableHash(value.resolutionEvidenceHash),
        reservedAt: timestamp(value.reservedAt) as string,
        runStartedAt: timestamp(value.runStartedAt, true),
        ambiguousAt: timestamp(value.ambiguousAt, true),
        resolvedAt: timestamp(value.resolvedAt, true),
        terminalizedAt: timestamp(value.terminalizedAt, true),
        usageReconciledAt: timestamp(value.usageReconciledAt, true),
        cleanupCompletedAt: timestamp(value.cleanupCompletedAt, true),
        updatedAt: timestamp(value.updatedAt) as string,
    };
    if (!['none', 'adopted_run', 'verified_no_run'].includes(parsed.resolutionKind)) {
        persistenceError();
    }
    return parsed;
}

function parseInventory(value: unknown): ProfileProviderCanaryCleanupInventory {
    if (!isRecord(value) || !Array.isArray(value.sourceRuns) || !Array.isArray(value.canaryRuns)
        || !UUID_PATTERN.test(String(value.sourceRequestId ?? ''))
        || value.sourceRuns.length !== 8 || value.canaryRuns.length > 2) persistenceError();
    const parsed = {
        sourceRequestId: String(value.sourceRequestId).toLowerCase(),
        sourceRuns: value.sourceRuns.map(item => {
            if (!isRecord(item) || typeof item.runId !== 'string'
                || !RUN_ID_PATTERN.test(item.runId)
                || !isApifyCredentialSlot(item.credentialSlot)) persistenceError();
            return { runId: item.runId, credentialSlot: item.credentialSlot };
        }),
        canaryRuns: value.canaryRuns.map(item => {
            if (!isRecord(item) || (item.repetition !== 1 && item.repetition !== 2)
                || typeof item.runId !== 'string' || !RUN_ID_PATTERN.test(item.runId)
                || item.credentialSlot !== 'primary') persistenceError();
            return {
                repetition: item.repetition as ProfileProviderCanaryRepetition,
                runId: item.runId,
                credentialSlot: 'primary' as const,
                reservationToken: typeof item.reservationToken === 'string'
                    && UUID_PATTERN.test(item.reservationToken)
                    ? item.reservationToken.toLowerCase()
                    : persistenceError(),
            };
        }),
    };
    if (new Set(parsed.sourceRuns.map(run => run.runId)).size !== 8
        || new Set(parsed.canaryRuns.map(run => run.runId)).size !== parsed.canaryRuns.length
        || new Set(parsed.canaryRuns.map(run => run.repetition)).size !== parsed.canaryRuns.length) {
        persistenceError();
    }
    return parsed;
}

function throwRpcError(error: { code?: string; message?: string }): never {
    const match = typeof error.message === 'string'
        ? error.message.match(/PROFILE_PROVIDER_CANARY_[A-Z0-9_]+/)
        : null;
    if (match) throw new Error(match[0]);
    throw new Error('PROFILE_PROVIDER_CANARY_RUN_PERSISTENCE_ERROR');
}

export function createProfileProviderCanaryRunStore(
    client: ProfileProviderCanarySupabaseClient = supabaseAdmin,
    dependencies: { randomUUID?: () => string } = {}
): ProfileProviderCanaryRunStore {
    const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
    const rpc = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
        const { data, error } = await client.rpc(name, params);
        if (error) throwRpcError(error);
        return data;
    };
    const key = (input: RunKey) => ({
        sourceRequestId: uuid(input.sourceRequestId),
        repetition: repetition(input.repetition),
    });
    const reserved = (input: ReservedRunKey) => ({
        ...key(input),
        reservationToken: uuid(input.reservationToken),
    });

    return {
        async loadSource(input) {
            return rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.sourceRpc, {
                p_source_request_id: uuid(input.sourceRequestId),
                p_owner_id: uuid(input.ownerId),
                p_owner_email: input.ownerEmail,
            });
        },
        async loadExperiment(input) {
            const data = await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.loadExperimentRpc, {
                p_source_request_id: uuid(input.sourceRequestId),
            });
            return data === null ? null : parseExperiment(data);
        },
        async loadRun(input) {
            const normalized = key(input);
            const data = await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.loadRunRpc, {
                p_source_request_id: normalized.sourceRequestId,
                p_repetition: normalized.repetition,
            });
            return data === null ? null : parseRun(data);
        },
        async reserve(input) {
            const normalized = key(input);
            if (input.restrictedAccessVerified !== true
                || input.sourceRunCount !== 8
                || input.candidateCount !== 15
                || input.uniqueCandidateCount !== 15
                || input.publicCandidateCount !== 15
                || input.incompleteCandidateCount !== 15
                || input.unavailableCandidateCount !== 0
                || input.primarySuccessCandidateCount !== 0
                || input.criticalCandidateCount !== 3) validationError();
            const proposed = uuid(randomUUID());
            const data = await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.reserveRpc, {
                p_source_request_id: normalized.sourceRequestId,
                p_repetition: normalized.repetition,
                p_source_run_count: 8,
                p_candidate_count: 15,
                p_unique_candidate_count: 15,
                p_public_candidate_count: 15,
                p_incomplete_candidate_count: 15,
                p_unavailable_candidate_count: 0,
                p_primary_success_candidate_count: 0,
                p_critical_candidate_count: 3,
                p_ordered_set_hmac: hmac(input.orderedSetHmac),
                p_restricted_access_verified: true,
                p_reservation_token: proposed,
            });
            if (!isRecord(data) || typeof data.created !== 'boolean') persistenceError();
            const parsed = {
                created: data.created,
                experiment: parseExperiment(data.experiment),
                run: parseRun(data.run),
            };
            if (parsed.run.reservationToken !== proposed && parsed.created) persistenceError();
            return parsed;
        },
        async checkpointStarted(input) {
            const normalized = reserved(input);
            return parseRun(await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.checkpointStartedRpc, {
                p_source_request_id: normalized.sourceRequestId,
                p_repetition: normalized.repetition,
                p_reservation_token: normalized.reservationToken,
                p_run_id: runId(input.runId),
            }));
        },
        async markAmbiguous(input) {
            const normalized = reserved(input);
            return parseRun(await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.markAmbiguousRpc, {
                p_source_request_id: normalized.sourceRequestId,
                p_repetition: normalized.repetition,
                p_reservation_token: normalized.reservationToken,
            }));
        },
        async terminalize(input) {
            const normalized = reserved(input);
            const counts = [input.successCount, input.unavailableCount,
                input.incompleteCount, input.otherFailureCount];
            if (input.terminalCount !== 15 || counts.some(value =>
                !Number.isSafeInteger(value) || value < 0 || value > 15)
                || counts.reduce((sum, value) => sum + value, 0) !== 15
                || !Number.isSafeInteger(input.criticalSuccessCount)
                || input.criticalSuccessCount < 0 || input.criticalSuccessCount > 3
                || !Number.isSafeInteger(input.latencyMs)
                || input.latencyMs < 0 || input.latencyMs > 300_000
                || typeof input.buildVerified !== 'boolean'
                || typeof input.restrictedAccessVerified !== 'boolean') validationError();
            return parseRun(await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.terminalizeRpc, {
                p_source_request_id: normalized.sourceRequestId,
                p_repetition: normalized.repetition,
                p_reservation_token: normalized.reservationToken,
                p_run_id: runId(input.runId),
                p_terminal_count: 15,
                p_success_count: input.successCount,
                p_unavailable_count: input.unavailableCount,
                p_incomplete_count: input.incompleteCount,
                p_other_failure_count: input.otherFailureCount,
                p_critical_success_count: input.criticalSuccessCount,
                p_latency_ms: input.latencyMs,
                p_build_verified: input.buildVerified,
                p_restricted_access_verified: input.restrictedAccessVerified,
            }));
        },
        async reconcileUsage(input) {
            const normalized = reserved(input);
            if (typeof input.actualUsageUsd !== 'number'
                || !Number.isFinite(input.actualUsageUsd)
                || input.actualUsageUsd < 0
                || input.actualUsageUsd > PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD
                || Number(input.actualUsageUsd.toFixed(12)) !== input.actualUsageUsd) {
                validationError();
            }
            const amount = Number(input.actualUsageUsd.toFixed(12));
            return parseRun(await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.reconcileUsageRpc, {
                p_source_request_id: normalized.sourceRequestId,
                p_repetition: normalized.repetition,
                p_reservation_token: normalized.reservationToken,
                p_run_id: runId(input.runId),
                p_actual_usage_usd: amount,
            }));
        },
        async markRunStorageClean(input) {
            const normalized = reserved(input);
            if (!['kvs', 'dataset', 'request_queue'].includes(input.storage)) validationError();
            return parseRun(await rpc(
                PROFILE_PROVIDER_CANARY_DATABASE_NAMES.markRunStorageCleanRpc,
                {
                    p_source_request_id: normalized.sourceRequestId,
                    p_repetition: normalized.repetition,
                    p_reservation_token: normalized.reservationToken,
                    p_run_id: runId(input.runId),
                    p_storage: input.storage,
                }
            ));
        },
        async beginTerminalization(input) {
            if (!['strict_failure', 'verified_no_run', 'completed',
                'aborted_by_operator', 'expired_waiting_for_repetition'].includes(input.reason)) {
                validationError();
            }
            const claimToken = uuid(randomUUID());
            return parseExperiment(await rpc(
                PROFILE_PROVIDER_CANARY_DATABASE_NAMES.beginTerminalizationRpc,
                {
                    p_source_request_id: uuid(input.sourceRequestId),
                    p_terminal_reason: input.reason,
                    p_cleanup_claim_token: claimToken,
                }
            ));
        },
        async claimExpiredForCleanup(input = {}) {
            const limit = input.limit ?? 4;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) validationError();
            const data = await rpc(PROFILE_PROVIDER_CANARY_DATABASE_NAMES.claimExpiredCleanupRpc, {
                p_limit: limit,
                p_cleanup_claim_token: uuid(randomUUID()),
            });
            if (!Array.isArray(data) || data.length > limit) persistenceError();
            return data.map(parseExperiment);
        },
        async loadCleanupInventory(input) {
            const sourceRequestId = uuid(input.sourceRequestId);
            const inventory = parseInventory(await rpc(
                PROFILE_PROVIDER_CANARY_DATABASE_NAMES.loadCleanupInventoryRpc,
                {
                    p_source_request_id: sourceRequestId,
                    p_cleanup_claim_token: uuid(input.cleanupClaimToken),
                }
            ));
            if (inventory.sourceRequestId !== sourceRequestId) persistenceError();
            return inventory;
        },
        async markSourceStorageClean(input) {
            if (!['kvs', 'dataset', 'request_queue'].includes(input.storage)) validationError();
            return parseExperiment(await rpc(
                PROFILE_PROVIDER_CANARY_DATABASE_NAMES.markSourceStorageCleanRpc,
                {
                    p_source_request_id: uuid(input.sourceRequestId),
                    p_cleanup_claim_token: uuid(input.cleanupClaimToken),
                    p_storage: input.storage,
                }
            ));
        },
        async completeExperimentCleanup(input) {
            return parseExperiment(await rpc(
                PROFILE_PROVIDER_CANARY_DATABASE_NAMES.completeCleanupRpc,
                {
                    p_source_request_id: uuid(input.sourceRequestId),
                    p_cleanup_claim_token: uuid(input.cleanupClaimToken),
                }
            ));
        },
    };
}

export const profileProviderCanaryRunStore = createProfileProviderCanaryRunStore();
