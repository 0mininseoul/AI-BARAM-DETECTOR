import { pathToFileURL } from 'node:url';
import {
    PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT,
    PROFILE_PROVIDER_CANARY_MAX_LATENCY_MS,
    PROFILE_PROVIDER_CANARY_MAX_REPORTED_LATENCY_MS,
    PROFILE_PROVIDER_CANARY_MAX_RUN_USD,
    PROFILE_PROVIDER_CANARY_REPEATS,
    parseInstagramProfileProviderCanaryArgs,
    sanitizeInstagramProfileProviderCanaryResult,
    type InstagramProfileProviderCanaryOptions,
    type SanitizedInstagramProfileProviderCanaryResult,
} from './canary-instagram-profile-provider-options';
import { PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD } from '../lib/services/analysis/profile-provider-canary-run-store';
import { createInstagramProfileProviderCanaryRuntimeDependencies } from './profile-provider-canary-runtime';

export type ProfileProviderCanaryOutcome =
    | 'success'
    | 'unavailable'
    | 'incomplete'
    | 'other_failure';

export interface ProfileProviderCanaryRunEvidence {
    outcomes: readonly ProfileProviderCanaryOutcome[];
    criticalSuccessCount: number;
    latencyMs: number;
    buildMatched: boolean;
    restrictedAccess: boolean;
}

export interface InstagramProfileProviderCanarySource {
    sourceRunIds: readonly string[];
    usernames: readonly string[];
    criticalIncompleteCount: number;
}

export type ProfileProviderCanaryStorage =
    | 'keyValueStore'
    | 'dataset'
    | 'requestQueue';

export interface InstagramProfileProviderCanaryRunRecord {
    repetition: 1 | 2;
    state: 'reserved' | 'running' | 'ambiguous' | 'terminal';
    runId: string | null;
    runStartedAtMs: number | null;
    evidence: ProfileProviderCanaryRunEvidence | null;
    terminalSucceeded: boolean | null;
    actualCostUsd: number | null;
    costStatus: 'actual' | 'conservative' | 'unknown';
    cleanup: Record<ProfileProviderCanaryStorage, boolean>;
    gatePassed: boolean | null;
}

function sameSource(
    left: InstagramProfileProviderCanarySource,
    right: InstagramProfileProviderCanarySource
): boolean {
    return left.criticalIncompleteCount === right.criticalIncompleteCount
        && left.sourceRunIds.length === right.sourceRunIds.length
        && left.usernames.length === right.usernames.length
        && left.sourceRunIds.every((value, index) => value === right.sourceRunIds[index])
        && left.usernames.every((value, index) => value === right.usernames[index]);
}

interface ApifyRunStorageClient {
    delete(): Promise<unknown>;
    get(): Promise<unknown | undefined>;
}

interface ApifyRunCleanupClient {
    keyValueStore(): ApifyRunStorageClient;
    dataset(): ApifyRunStorageClient;
    requestQueue(): ApifyRunStorageClient;
}

export interface ProfileProviderCanaryApifyClient {
    run(runId: string): ApifyRunCleanupClient;
}

export interface InstagramProfileProviderCanaryDependencies {
    resumeTerminalization(input: { sourceRequestId: string }): Promise<{
        runs: InstagramProfileProviderCanaryRunRecord[];
    } | null>;
    loadSource(input: { sourceRequestId: string }): Promise<InstagramProfileProviderCanarySource>;
    assertPaidReadiness(): Promise<void>;
    loadRun(repetition: 1 | 2): Promise<InstagramProfileProviderCanaryRunRecord | null>;
    reserveRun(input: {
        sourceRequestId: string;
        repetition: 1 | 2;
        requestedCount: 15;
        maximumRunChargeUsd: 0.05;
    }): Promise<{ created: boolean; run: InstagramProfileProviderCanaryRunRecord }>;
    checkpointStarted(input: {
        repetition: 1 | 2;
        runId: string;
    }): Promise<InstagramProfileProviderCanaryRunRecord>;
    markAmbiguous(input: {
        repetition: 1 | 2;
    }): Promise<InstagramProfileProviderCanaryRunRecord>;
    terminalize(input: {
        repetition: 1 | 2;
        runId: string;
        evidence: ProfileProviderCanaryRunEvidence;
        gatePassed: boolean;
    }): Promise<InstagramProfileProviderCanaryRunRecord>;
    reconcileActualCost(input: {
        repetition: 1 | 2;
        actualCostUsd: number;
    }): Promise<InstagramProfileProviderCanaryRunRecord>;
    markStorageCleaned(input: {
        repetition: 1 | 2;
        storage: ProfileProviderCanaryStorage;
    }): Promise<InstagramProfileProviderCanaryRunRecord>;
    beginTerminalization(input: {
        sourceRequestId: string;
        status: 'completed' | 'strict_failure';
    }): Promise<void>;
    markSourceStorageCleaned(input: {
        sourceRequestId: string;
        storage: ProfileProviderCanaryStorage;
    }): Promise<void>;
    markExperimentTerminal(input: {
        sourceRequestId: string;
        status: 'completed' | 'failed_gate';
    }): Promise<void>;
    executeRun(input: {
        usernames: readonly string[];
        resumeRunId?: string;
        durableRunStartedAtMs?: number;
        maximumRunChargeUsd: 0.05;
        onRunStarted(runId: string): Promise<InstagramProfileProviderCanaryRunRecord>;
    }): Promise<ProfileProviderCanaryRunEvidence>;
    getStableActualCost(runId: string): Promise<number | null>;
    getApifyClient(): ProfileProviderCanaryApifyClient;
    writeStdout?(value: string): void;
}

const STORAGE_ORDER: readonly ProfileProviderCanaryStorage[] = [
    'keyValueStore',
    'dataset',
    'requestQueue',
];

function safeError(code: string): Error {
    return new Error(code);
}

function assertSource(source: InstagramProfileProviderCanarySource): void {
    const sourceIds = source.sourceRunIds;
    const usernames = source.usernames;
    const validText = (value: unknown) => typeof value === 'string' && value.length > 0;
    if (sourceIds.length !== 8
        || !sourceIds.every(validText)
        || new Set(sourceIds).size !== sourceIds.length
        || usernames.length !== PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT
        || !usernames.every(validText)
        || new Set(usernames.map(username => username.toLowerCase())).size !== usernames.length
        || source.criticalIncompleteCount !== 3) {
        throw safeError('SOURCE_INVALID');
    }
}

function assertEvidence(evidence: ProfileProviderCanaryRunEvidence): void {
    const allowedOutcomes: readonly ProfileProviderCanaryOutcome[] = [
        'success', 'unavailable', 'incomplete', 'other_failure',
    ];
    if (evidence.outcomes.length !== PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT
        || !evidence.outcomes.every(outcome => allowedOutcomes.includes(outcome))
        || !Number.isInteger(evidence.criticalSuccessCount)
        || evidence.criticalSuccessCount < 0
        || evidence.criticalSuccessCount > 3
        || !Number.isInteger(evidence.latencyMs)
        || evidence.latencyMs < 0
        || evidence.latencyMs > PROFILE_PROVIDER_CANARY_MAX_REPORTED_LATENCY_MS
        || typeof evidence.buildMatched !== 'boolean'
        || typeof evidence.restrictedAccess !== 'boolean') {
        throw safeError('RUN_EVIDENCE_INVALID');
    }
}

function gatePassed(evidence: ProfileProviderCanaryRunEvidence): boolean {
    return evidence.outcomes.length === PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT
        && evidence.outcomes.every(outcome => outcome === 'success')
        && evidence.criticalSuccessCount === 3
        && evidence.latencyMs <= PROFILE_PROVIDER_CANARY_MAX_LATENCY_MS
        && evidence.buildMatched
        && evidence.restrictedAccess;
}

function reportRun(run: InstagramProfileProviderCanaryRunRecord) {
    const evidence = run.evidence;
    const outcomes = evidence?.outcomes ?? [];
    return {
        repetition: run.repetition,
        lifecycleStatus: run.state === 'terminal'
            ? run.terminalSucceeded ? 'succeeded' : 'failed'
            : run.state,
        terminalCount: outcomes.length,
        successCount: outcomes.filter(outcome => outcome === 'success').length,
        unavailableCount: outcomes.filter(outcome => outcome === 'unavailable').length,
        incompleteCount: outcomes.filter(outcome => outcome === 'incomplete').length,
        otherFailureCount: outcomes.filter(outcome => outcome === 'other_failure').length,
        latencyMs: evidence?.latencyMs ?? 0,
        buildMatched: evidence?.buildMatched ?? false,
        restrictedAccess: evidence?.restrictedAccess ?? false,
        actualCostUsd: run.actualCostUsd,
        costStatus: run.costStatus,
        cleanup: run.cleanup,
        gatePassed: run.gatePassed === true,
    };
}

function selectStorage(
    run: ApifyRunCleanupClient,
    storage: ProfileProviderCanaryStorage
): ApifyRunStorageClient {
    return run[storage]();
}

export async function deleteAndVerifyApifyRunStorage(
    client: ProfileProviderCanaryApifyClient,
    runId: string,
    storage: ProfileProviderCanaryStorage
): Promise<void> {
    const resource = selectStorage(client.run(runId), storage);
    try {
        await resource.delete();
    } catch {
        // The authoritative postcondition is the follow-up GET, including idempotent retries.
    }
    let remaining: unknown;
    try {
        remaining = await resource.get();
    } catch {
        throw safeError('STORAGE_CLEANUP_UNVERIFIED');
    }
    if (remaining !== undefined) {
        throw safeError('STORAGE_CLEANUP_UNVERIFIED');
    }
}

async function cleanCanaryRun(
    run: InstagramProfileProviderCanaryRunRecord,
    dependencies: InstagramProfileProviderCanaryDependencies,
    client: ProfileProviderCanaryApifyClient
): Promise<InstagramProfileProviderCanaryRunRecord> {
    if (!run.runId) throw safeError('RUN_ID_MISSING');
    const confirmedRunId = run.runId;
    let current = run;
    for (const storage of STORAGE_ORDER) {
        if (current.cleanup[storage]) continue;
        await deleteAndVerifyApifyRunStorage(client, confirmedRunId, storage);
        current = await dependencies.markStorageCleaned({
            repetition: current.repetition,
            storage,
        });
    }
    return current;
}

async function cleanSourceRuns(
    source: InstagramProfileProviderCanarySource,
    sourceRequestId: string,
    dependencies: InstagramProfileProviderCanaryDependencies,
    client: ProfileProviderCanaryApifyClient
): Promise<void> {
    for (const storage of STORAGE_ORDER) {
        for (const runId of source.sourceRunIds) {
            await deleteAndVerifyApifyRunStorage(client, runId, storage);
        }
        await dependencies.markSourceStorageCleaned({ sourceRequestId, storage });
    }
}

function baseReport(
    mode: 'replay' | 'paid_canary',
    source: InstagramProfileProviderCanarySource,
    options: InstagramProfileProviderCanaryOptions,
    runs: InstagramProfileProviderCanaryRunRecord[],
    terminal: boolean,
    sourceCleanupComplete: boolean
): SanitizedInstagramProfileProviderCanaryResult {
    const actualCosts = runs
        .map(run => run.actualCostUsd)
        .filter((cost): cost is number => cost !== null);
    const allActual = runs.length > 0 && actualCosts.length === runs.length;
    const allPassed = runs.length === PROFILE_PROVIDER_CANARY_REPEATS
        && runs.every(run => run.gatePassed === true)
        && allActual
        && runs.every(run => STORAGE_ORDER.every(storage => run.cleanup[storage]));
    return sanitizeInstagramProfileProviderCanaryResult({
        mode,
        sourceRunCount: source.sourceRunIds.length,
        requestedCount: source.usernames.length,
        criticalIncompleteCount: source.criticalIncompleteCount,
        runs: runs.map(reportRun),
        totalActualCostUsd: mode === 'replay'
            ? 0
            : allActual
                ? actualCosts.reduce((total, cost) => total + cost, 0)
                : null,
        sessionMaximumExposureUsd: options.maximumTotalChargeUsd,
        costStatus: mode === 'replay' || allActual ? 'actual' : runs.some(run => run.costStatus === 'unknown')
            ? 'unknown'
            : 'conservative',
        sourceCleanupComplete,
        experimentTerminal: terminal,
        gatePassed: allPassed && sourceCleanupComplete && terminal,
    });
}

export async function runInstagramProfileProviderCanary(
    options: InstagramProfileProviderCanaryOptions,
    dependencies: InstagramProfileProviderCanaryDependencies
): Promise<SanitizedInstagramProfileProviderCanaryResult> {
    if (options.confirmPaidApiCall) {
        const resumedTerminalization = await dependencies.resumeTerminalization({
            sourceRequestId: options.sourceRequestId,
        });
        if (resumedTerminalization) {
            return baseReport(
                'paid_canary',
                {
                    sourceRunIds: Array.from({ length: 8 }, (_, index) => `retained-${index}`),
                    usernames: Array.from({ length: 15 }, (_, index) => `retained-${index}`),
                    criticalIncompleteCount: 3,
                },
                {
                    ...options,
                    maximumTotalChargeUsd: 0.10,
                },
                resumedTerminalization.runs,
                true,
                true
            );
        }
    }
    let source = await dependencies.loadSource({ sourceRequestId: options.sourceRequestId });
    assertSource(source);

    if (!options.confirmPaidApiCall) {
        return baseReport('replay', source, options, [], false, false);
    }

    const completedRuns: InstagramProfileProviderCanaryRunRecord[] = [];
    const client = dependencies.getApifyClient();

    for (let numericRepetition = 1; numericRepetition <= PROFILE_PROVIDER_CANARY_REPEATS; numericRepetition += 1) {
        const repetition = numericRepetition as 1 | 2;
        if (repetition === 2) {
            const reloaded = await dependencies.loadSource({
                sourceRequestId: options.sourceRequestId,
            });
            assertSource(reloaded);
            if (!sameSource(source, reloaded)) throw safeError('SOURCE_CHANGED');
            source = reloaded;
        }
        let current = await dependencies.loadRun(repetition);
        let created = false;

        if (!current) {
            await dependencies.assertPaidReadiness();
            const reservation = await dependencies.reserveRun({
                sourceRequestId: options.sourceRequestId,
                repetition,
                requestedCount: PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT,
                maximumRunChargeUsd: PROFILE_PROVIDER_CANARY_MAX_RUN_USD,
            });
            current = reservation.run;
            created = reservation.created;
        }

        if (current.state === 'ambiguous' || (current.state === 'reserved' && !created)) {
            if (current.state === 'reserved') {
                current = await dependencies.markAmbiguous({ repetition });
            }
            completedRuns.push(current);
            return baseReport('paid_canary', source, options, completedRuns, false, false);
        }

        if (current.state !== 'terminal') {
            let confirmedRunId = current.runId;
            let runEvidence: ProfileProviderCanaryRunEvidence;
            try {
                runEvidence = await dependencies.executeRun({
                    usernames: source.usernames,
                    ...(confirmedRunId ? { resumeRunId: confirmedRunId } : {}),
                    ...(current.runStartedAtMs === null
                        ? {}
                        : { durableRunStartedAtMs: current.runStartedAtMs }),
                    maximumRunChargeUsd: PROFILE_PROVIDER_CANARY_MAX_RUN_USD,
                    onRunStarted: async runId => {
                        if (confirmedRunId && confirmedRunId !== runId) {
                            throw safeError('RUN_ID_MISMATCH');
                        }
                        confirmedRunId = runId;
                        current = await dependencies.checkpointStarted({ repetition, runId });
                        return current;
                    },
                });
            } catch {
                if (!confirmedRunId || current.state === 'reserved') {
                    current = await dependencies.markAmbiguous({ repetition });
                    completedRuns.push(current);
                    return baseReport('paid_canary', source, options, completedRuns, false, false);
                }
                throw safeError('RUN_EXECUTION_INTERRUPTED');
            }
            if (!confirmedRunId) {
                current = await dependencies.markAmbiguous({ repetition });
                completedRuns.push(current);
                return baseReport('paid_canary', source, options, completedRuns, false, false);
            }
            assertEvidence(runEvidence);
            current = await dependencies.terminalize({
                repetition,
                runId: confirmedRunId,
                evidence: runEvidence,
                gatePassed: gatePassed(runEvidence),
            });
        }

        if (!current.runId || !current.evidence) {
            throw safeError('TERMINAL_RUN_INVALID');
        }

        if (current.costStatus !== 'actual' || current.actualCostUsd === null) {
            const actualCostUsd = await dependencies.getStableActualCost(current.runId);
            if (actualCostUsd === null) {
                completedRuns.push(current);
                return baseReport('paid_canary', source, options, completedRuns, false, false);
            }
            if (!Number.isFinite(actualCostUsd)
                || actualCostUsd < 0
                || actualCostUsd > PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD) {
                throw safeError('ACTUAL_COST_OUT_OF_BOUNDS');
            }
            current = await dependencies.reconcileActualCost({ repetition, actualCostUsd });
        }

        current = await cleanCanaryRun(current, dependencies, client);
        completedRuns.push(current);

        if (current.gatePassed !== true) {
            await dependencies.beginTerminalization({
                sourceRequestId: options.sourceRequestId,
                status: 'strict_failure',
            });
            await cleanSourceRuns(source, options.sourceRequestId, dependencies, client);
            await dependencies.markExperimentTerminal({
                sourceRequestId: options.sourceRequestId,
                status: 'failed_gate',
            });
            return baseReport('paid_canary', source, options, completedRuns, true, true);
        }
    }

    await dependencies.beginTerminalization({
        sourceRequestId: options.sourceRequestId,
        status: 'completed',
    });
    await cleanSourceRuns(source, options.sourceRequestId, dependencies, client);
    await dependencies.markExperimentTerminal({
        sourceRequestId: options.sourceRequestId,
        status: 'completed',
    });
    return baseReport('paid_canary', source, options, completedRuns, true, true);
}

function defaultDependencies(): InstagramProfileProviderCanaryDependencies {
    return createInstagramProfileProviderCanaryRuntimeDependencies();
}

export async function runInstagramProfileProviderCanaryCli(
    args: readonly string[],
    dependencies: InstagramProfileProviderCanaryDependencies = defaultDependencies()
): Promise<SanitizedInstagramProfileProviderCanaryResult> {
    const result = await runInstagramProfileProviderCanary(
        parseInstagramProfileProviderCanaryArgs(args),
        dependencies
    );
    (dependencies.writeStdout ?? (value => process.stdout.write(value)))(
        `${JSON.stringify(result)}\n`
    );
    return result;
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runInstagramProfileProviderCanaryCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            error_code: 'instagram_profile_provider_canary_failed',
        })}\n`);
        process.exitCode = 1;
    });
}
