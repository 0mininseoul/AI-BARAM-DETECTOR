import {
    REPLACEMENT_PROFILE_ACTOR,
    REPLACEMENT_PROFILE_MAX_CHARGE_USD,
    runReplacementProfileDetails,
} from '@/lib/services/instagram/providers/apify-profile-details';
import {
    getApifyClient,
    type ApifyClientLike,
} from '@/lib/services/instagram/providers/apify-relationship';
import type {
    ApifyCredentialSlot,
    ProfileAttemptResult,
    ProviderCallContext,
    ProviderRunCheckpoint,
} from '@/lib/services/instagram/providers/types';
import { canonicalProviderInput, checkedMaximumCharge } from './v2-provider-identity';

/** The provider operation kind under which a repair run is reserved and keyed in the ledger. */
export const ANALYSIS_V2_PROFILE_REPAIR_OPERATION = 'profile-repair' as const;

/**
 * Canonical durable identity for a repair run. The pinned build is part of the identity so that a
 * build bump can never resume or be mistaken for a run produced by the previous build, and the
 * usernames are length-prefixed so the set and its order are both fixed.
 */
export function profileRepairIdentity(usernames: readonly string[]): string {
    return canonicalProviderInput([
        'profile-repair-v1',
        REPLACEMENT_PROFILE_ACTOR.actorId,
        REPLACEMENT_PROFILE_ACTOR.build,
        ...usernames,
    ]);
}

/**
 * The single normalised charge ceiling for a repair run, written to the ledger and handed to the
 * adapter. The rate and cap are fixed to the replacement Actor's known economics rather than being
 * env-tunable: this value is a hard fence on a paid call, and `runReplacementProfileDetails`
 * re-checks the same `REPLACEMENT_PROFILE_MAX_CHARGE_USD` cap internally, so nothing outside this
 * module can widen it. Worst case is 30 × 0.0027 = 0.081, inside the 0.09 cap.
 */
export function profileRepairMaximumCharge(count: number): number {
    return checkedMaximumCharge(
        count * REPLACEMENT_PROFILE_ACTOR.estimatedResultCostUsd,
        REPLACEMENT_PROFILE_MAX_CHARGE_USD,
        'profile repair'
    );
}

export interface RunAnalysisV2ProfileRepairInput {
    usernames: readonly string[];
    credentialSlot: ApifyCredentialSlot;
    providerRunCheckpoint: ProviderRunCheckpoint;
    env: Record<string, string | undefined>;
    /** Injectable for tests; production resolves it from the credential slot. */
    client?: ApifyClientLike;
}

/**
 * Run or resume exactly one pinned replacement-profile Actor for the repair set and return one
 * terminal outcome per requested username. Cleanup of the run's external storage is the caller's
 * responsibility after it durably checkpoints these outcomes. RESTRICTED-access pinning and the
 * cost fence are enforced inside `runReplacementProfileDetails`; this adapter only computes the
 * charge, resolves the client, and threads the durable-run checkpoint through as the call context.
 */
export async function runAnalysisV2ProfileRepair(
    input: RunAnalysisV2ProfileRepairInput
): Promise<ProfileAttemptResult[]> {
    const maxTotalChargeUsd = profileRepairMaximumCharge(input.usernames.length);
    const client = input.client ?? getApifyClient(input.env, input.credentialSlot);
    const context: ProviderCallContext = {
        ...input.providerRunCheckpoint,
        recordUsage: () => undefined,
    };
    return runReplacementProfileDetails({
        client,
        usernames: input.usernames,
        credentialSlot: input.credentialSlot,
        maxTotalChargeUsd,
        context,
    });
}
