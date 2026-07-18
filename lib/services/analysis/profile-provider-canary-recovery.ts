import { getApifyClient } from '@/lib/services/instagram/providers/apify-relationship';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    profileProviderCanaryRunStore,
    type ProfileProviderCanaryCleanupInventory,
    type ProfileProviderCanaryRepetition,
    type ProfileProviderCanaryStorage,
} from './profile-provider-canary-run-store';

export const PROFILE_PROVIDER_CANARY_RECOVERY_MAX_ROWS = 16;

interface StorageClient {
    get(): Promise<unknown | undefined>;
    delete(): Promise<void>;
}

interface RunClient {
    keyValueStore(): StorageClient;
    dataset(): StorageClient;
    requestQueue(): StorageClient;
}

interface CleanupClient {
    run(runId: string): RunClient;
}

interface RecoveryStore {
    claimExpiredForCleanup(input: { limit: number }): Promise<Array<{
        sourceRequestId: string;
        cleanupClaimToken: string | null;
    }>>;
    loadCleanupInventory(input: {
        sourceRequestId: string;
        cleanupClaimToken: string;
    }): Promise<ProfileProviderCanaryCleanupInventory>;
    markRunStorageClean(input: {
        sourceRequestId: string;
        repetition: ProfileProviderCanaryRepetition;
        reservationToken: string;
        runId: string;
        storage: ProfileProviderCanaryStorage;
    }): Promise<unknown>;
    markSourceStorageClean(input: {
        sourceRequestId: string;
        cleanupClaimToken: string;
        storage: ProfileProviderCanaryStorage;
    }): Promise<unknown>;
    completeExperimentCleanup(input: {
        sourceRequestId: string;
        cleanupClaimToken: string;
    }): Promise<unknown>;
}

export interface ProfileProviderCanaryRecoverySummary {
    scanned: number;
    finalized: number;
    failed: number;
}

interface RecoveryDependencies {
    store?: RecoveryStore;
    clientForSlot?: (slot: ApifyCredentialSlot) => CleanupClient;
    limit?: number;
    env?: Record<string, string | undefined>;
}

function clientForSlot(
    slot: ApifyCredentialSlot,
    dependencies: RecoveryDependencies
): CleanupClient {
    return dependencies.clientForSlot?.(slot)
        ?? getApifyClient(dependencies.env ?? process.env, slot);
}

function storageClient(run: RunClient, storage: ProfileProviderCanaryStorage): StorageClient {
    switch (storage) {
        case 'kvs': return run.keyValueStore();
        case 'dataset': return run.dataset();
        case 'request_queue': return run.requestQueue();
    }
}

async function deleteAndVerifyAbsent(storage: StorageClient): Promise<void> {
    if (await storage.get() === undefined) return;
    try {
        await storage.delete();
    } catch (deleteError) {
        if (await storage.get() === undefined) return;
        throw deleteError;
    }
    if (await storage.get() !== undefined) {
        throw new Error('PROFILE_PROVIDER_CANARY_STORAGE_CLEANUP_NOT_VERIFIED');
    }
}

async function finalizeClaim(
    experiment: Awaited<ReturnType<RecoveryStore['claimExpiredForCleanup']>>[number],
    store: RecoveryStore,
    dependencies: RecoveryDependencies
): Promise<void> {
    const cleanupClaimToken = experiment.cleanupClaimToken;
    if (!cleanupClaimToken) {
        throw new Error('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_INVALID');
    }
    const inventory = await store.loadCleanupInventory({
        sourceRequestId: experiment.sourceRequestId,
        cleanupClaimToken,
    });
    if (inventory.sourceRequestId !== experiment.sourceRequestId.toLowerCase()
        || inventory.sourceRuns.length !== 8
        || new Set(inventory.sourceRuns.map(run => run.runId)).size !== 8) {
        throw new Error('PROFILE_PROVIDER_CANARY_CLEANUP_INVENTORY_INVALID');
    }
    const storageKinds = ['kvs', 'dataset', 'request_queue'] as const;

    for (const storage of storageKinds) {
        for (const sourceRun of inventory.sourceRuns) {
            await deleteAndVerifyAbsent(storageClient(
                clientForSlot(sourceRun.credentialSlot, dependencies).run(sourceRun.runId),
                storage
            ));
        }
        await store.markSourceStorageClean({
            sourceRequestId: experiment.sourceRequestId,
            cleanupClaimToken,
            storage,
        });
    }

    for (const canaryRun of inventory.canaryRuns) {
        for (const storage of storageKinds) {
            await deleteAndVerifyAbsent(storageClient(
                clientForSlot(canaryRun.credentialSlot, dependencies).run(canaryRun.runId),
                storage
            ));
            await store.markRunStorageClean({
                sourceRequestId: experiment.sourceRequestId,
                repetition: canaryRun.repetition,
                reservationToken: canaryRun.reservationToken,
                runId: canaryRun.runId,
                storage,
            });
        }
    }
    await store.completeExperimentCleanup({
        sourceRequestId: experiment.sourceRequestId,
        cleanupClaimToken,
    });
}

/**
 * Cleanup-only recovery. It has no Actor handle and therefore cannot reserve,
 * start, resurrect, or replace a provider run.
 */
export async function recoverExpiredProfileProviderCanaries(
    dependencies: RecoveryDependencies = {}
): Promise<ProfileProviderCanaryRecoverySummary> {
    const store = dependencies.store ?? profileProviderCanaryRunStore;
    const limit = dependencies.limit ?? 4;
    if (!Number.isSafeInteger(limit) || limit < 1
        || limit > PROFILE_PROVIDER_CANARY_RECOVERY_MAX_ROWS) {
        throw new Error('PROFILE_PROVIDER_CANARY_RECOVERY_INVALID_LIMIT');
    }
    const experiments = await store.claimExpiredForCleanup({ limit });
    const summary: ProfileProviderCanaryRecoverySummary = {
        scanned: experiments.length,
        finalized: 0,
        failed: 0,
    };
    for (const experiment of experiments) {
        try {
            await finalizeClaim(experiment, store, dependencies);
            summary.finalized += 1;
        } catch {
            summary.failed += 1;
        }
    }
    return Object.freeze(summary);
}
