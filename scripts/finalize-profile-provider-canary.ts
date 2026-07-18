import { pathToFileURL } from 'node:url';
import {
    deleteAndVerifyApifyRunStorage,
    type ProfileProviderCanaryApifyClient,
    type ProfileProviderCanaryStorage,
} from './canary-instagram-profile-provider';
import { createFinalizeProfileProviderCanaryRuntimeDependencies } from './profile-provider-canary-runtime';
import type { ProfileProviderCanaryTerminalReason } from '../lib/services/analysis/profile-provider-canary-run-store';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_ORDER: readonly ProfileProviderCanaryStorage[] = [
    'keyValueStore',
    'dataset',
    'requestQueue',
];

export interface FinalizeProfileProviderCanaryOptions {
    sourceRequestId: string;
    confirmCleanupOnly: true;
}

export interface FinalizeProfileProviderCanaryContext {
    canaryRuns: Array<{
        repetition: 1 | 2;
        runId: string;
        actualCostSettled: boolean;
        cleanup: Record<ProfileProviderCanaryStorage, boolean>;
    }>;
    sourceRunIds: readonly string[];
    sourceCleanup: Record<ProfileProviderCanaryStorage, boolean>;
}

export interface FinalizeProfileProviderCanaryResult {
    mode: 'finalize_profile_provider_canary';
    canary_run_count: number;
    source_run_count: 8;
    storage_delete_verification_count: number;
    source_cleanup_complete: true;
    experiment_status: ProfileProviderCanaryTerminalReason;
    actor_start_count: 0;
}

export interface FinalizeProfileProviderCanaryDependencies {
    resumeFinalization(input: {
        sourceRequestId: string;
    }): Promise<{
        state: 'terminalizing';
        terminalReason: ProfileProviderCanaryTerminalReason;
        context: FinalizeProfileProviderCanaryContext;
    } | {
        state: 'experiment_terminal';
        terminalReason: ProfileProviderCanaryTerminalReason;
        canaryRunCount: number;
    } | null>;
    loadFinalizationContext(input: {
        sourceRequestId: string;
    }): Promise<FinalizeProfileProviderCanaryContext>;
    getApifyClient(): ProfileProviderCanaryApifyClient;
    beginTerminalization(input: {
        sourceRequestId: string;
        status: 'aborted_by_operator';
    }): Promise<void>;
    markCanaryStorageCleaned(input: {
        sourceRequestId: string;
        repetition: 1 | 2;
        storage: ProfileProviderCanaryStorage;
    }): Promise<void>;
    markSourceStorageCleaned(input: {
        sourceRequestId: string;
        storage: ProfileProviderCanaryStorage;
    }): Promise<void>;
    markExperimentTerminal(input: {
        sourceRequestId: string;
        status: ProfileProviderCanaryTerminalReason;
    }): Promise<void>;
    writeStdout?(value: string): void;
}

function safeError(code: string): Error {
    return new Error(code);
}

export function parseFinalizeProfileProviderCanaryArgs(
    args: readonly string[]
): FinalizeProfileProviderCanaryOptions {
    let sourceRequestId: string | null = null;
    let confirmationCount = 0;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--source-request-id') {
            if (sourceRequestId !== null) {
                throw safeError('--source-request-id must appear exactly once');
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw safeError('--source-request-id is required');
            }
            sourceRequestId = value;
            index += 1;
            continue;
        }
        if (argument === '--confirm-cleanup-only') {
            confirmationCount += 1;
            if (confirmationCount > 1) {
                throw safeError('--confirm-cleanup-only must appear exactly once');
            }
            continue;
        }
        if (argument.startsWith('--confirm-cleanup-only=')) {
            throw safeError('--confirm-cleanup-only must be exact and valueless');
        }
        throw safeError(`unknown argument: ${argument}`);
    }

    if (!sourceRequestId || confirmationCount !== 1) {
        throw safeError('all cleanup-only arguments are required');
    }
    if (!UUID_PATTERN.test(sourceRequestId)) {
        throw safeError('invalid arguments');
    }
    return { sourceRequestId, confirmCleanupOnly: true };
}

function assertContext(context: FinalizeProfileProviderCanaryContext): void {
    const validRunId = (value: unknown) => typeof value === 'string' && value.length > 0;
    if (context.sourceRunIds.length !== 8
        || !context.sourceRunIds.every(validRunId)
        || new Set(context.sourceRunIds).size !== context.sourceRunIds.length
        || context.canaryRuns.length > 2
        || new Set(context.canaryRuns.map(run => run.repetition)).size !== context.canaryRuns.length
        || !context.canaryRuns.every(run => (
            (run.repetition === 1 || run.repetition === 2)
            && validRunId(run.runId)
            && typeof run.actualCostSettled === 'boolean'
            && STORAGE_ORDER.every(storage => typeof run.cleanup[storage] === 'boolean')
        ))
        || !STORAGE_ORDER.every(storage => typeof context.sourceCleanup[storage] === 'boolean')) {
        throw safeError('FINALIZATION_CONTEXT_INVALID');
    }
}

export async function finalizeProfileProviderCanary(
    options: FinalizeProfileProviderCanaryOptions,
    dependencies: FinalizeProfileProviderCanaryDependencies
): Promise<FinalizeProfileProviderCanaryResult> {
    const identity = { sourceRequestId: options.sourceRequestId };
    const resumed = await dependencies.resumeFinalization(identity);
    if (resumed?.state === 'experiment_terminal') {
        return {
            mode: 'finalize_profile_provider_canary',
            canary_run_count: resumed.canaryRunCount,
            source_run_count: 8,
            storage_delete_verification_count: 0,
            source_cleanup_complete: true,
            experiment_status: resumed.terminalReason,
            actor_start_count: 0,
        };
    }
    const context = resumed?.context
        ?? await dependencies.loadFinalizationContext(identity);
    const terminalReason = resumed?.terminalReason ?? 'aborted_by_operator';
    assertContext(context);
    if (context.canaryRuns.some(run => !run.actualCostSettled)) {
        throw safeError('ACTUAL_COST_NOT_SETTLED');
    }
    if (!resumed) {
        await dependencies.beginTerminalization({
            ...identity,
            status: 'aborted_by_operator',
        });
    }

    const client = dependencies.getApifyClient();
    let storageDeleteVerificationCount = 0;
    for (const canaryRun of context.canaryRuns) {
        for (const storage of STORAGE_ORDER) {
            if (canaryRun.cleanup[storage]) continue;
            await deleteAndVerifyApifyRunStorage(client, canaryRun.runId, storage);
            storageDeleteVerificationCount += 1;
            await dependencies.markCanaryStorageCleaned({
                ...identity,
                repetition: canaryRun.repetition,
                storage,
            });
        }
    }

    for (const storage of STORAGE_ORDER) {
        if (context.sourceCleanup[storage]) continue;
        for (const runId of context.sourceRunIds) {
            await deleteAndVerifyApifyRunStorage(client, runId, storage);
            storageDeleteVerificationCount += 1;
        }
        await dependencies.markSourceStorageCleaned({ ...identity, storage });
    }
    await dependencies.markExperimentTerminal({
        ...identity,
        status: terminalReason,
    });

    return {
        mode: 'finalize_profile_provider_canary',
        canary_run_count: context.canaryRuns.length,
        source_run_count: 8,
        storage_delete_verification_count: storageDeleteVerificationCount,
        source_cleanup_complete: true,
        experiment_status: terminalReason,
        actor_start_count: 0,
    };
}

function defaultDependencies(): FinalizeProfileProviderCanaryDependencies {
    return createFinalizeProfileProviderCanaryRuntimeDependencies();
}

export async function runFinalizeProfileProviderCanaryCli(
    args: readonly string[],
    dependencies: FinalizeProfileProviderCanaryDependencies = defaultDependencies()
): Promise<FinalizeProfileProviderCanaryResult> {
    const finalized = await finalizeProfileProviderCanary(
        parseFinalizeProfileProviderCanaryArgs(args),
        dependencies
    );
    (dependencies.writeStdout ?? (value => process.stdout.write(value)))(
        `${JSON.stringify(finalized)}\n`
    );
    return finalized;
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runFinalizeProfileProviderCanaryCli(process.argv.slice(2)).catch(() => {
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            error_code: 'profile_provider_canary_finalization_failed',
        })}\n`);
        process.exitCode = 1;
    });
}
