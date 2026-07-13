import { z } from 'zod';

export const PROFILE_FETCH_SOURCES = ['cache', 'selfhosted', 'apify'] as const;
export const PROFILE_FETCH_FAILURE_CATEGORIES = [
    'not_found',
    'empty_user',
    'auth',
    'rate_limit',
    'timeout',
    'schema',
    'transport',
    'http',
    'unknown',
] as const;

export type ProfileFetchSource = typeof PROFILE_FETCH_SOURCES[number];
export type ProfileFetchFailureCategory =
    typeof PROFILE_FETCH_FAILURE_CATEGORIES[number];

const usernameSchema = z.string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9._]+$/)
    .transform(value => value.toLowerCase());

const commonOutcomeSchema = z.object({
    requestedUsername: usernameSchema,
    source: z.enum(PROFILE_FETCH_SOURCES),
    requestCount: z.number().int().min(0).max(10),
    latencyMs: z.number().int().min(0).max(300_000),
    capturedAt: z.string().datetime({ offset: true }),
});

export const profileFetchOutcomeSchema = z.discriminatedUnion('status', [
    commonOutcomeSchema.extend({
        status: z.literal('success'),
        failureCategory: z.null(),
        httpStatus: z.null(),
    }).strict(),
    commonOutcomeSchema.extend({
        status: z.literal('unavailable'),
        failureCategory: z.enum(['not_found', 'empty_user']),
        httpStatus: z.union([z.literal(404), z.null()]),
    }).strict(),
    commonOutcomeSchema.extend({
        status: z.literal('failed'),
        failureCategory: z.enum([
            'auth',
            'rate_limit',
            'timeout',
            'schema',
            'transport',
            'http',
            'unknown',
        ]),
        httpStatus: z.number().int().min(400).max(599).nullable(),
    }).strict(),
]);

export type ProfileFetchOutcome = z.infer<typeof profileFetchOutcomeSchema>;

export interface ProfileFetchOutcomeSummary {
    requested: number;
    succeeded: number;
    unavailable: number;
    failed: number;
    unresolvedUsernames: string[];
    failureCounts: Partial<Record<ProfileFetchFailureCategory, number>>;
}

/**
 * Produces the exact unresolved set used by the paid fallback. A username must have one
 * terminal outcome for a provider attempt so individual failures cannot disappear inside
 * Promise.allSettled.
 */
export function summarizeProfileFetchOutcomes(
    requestedUsernames: readonly string[],
    outcomes: readonly ProfileFetchOutcome[]
): ProfileFetchOutcomeSummary {
    const requested = requestedUsernames.map(value => usernameSchema.parse(value));
    const requestedSet = new Set(requested);
    if (requestedSet.size !== requested.length) {
        throw new Error('PROFILE_FETCH_OUTCOME_ERROR: duplicate requested username.');
    }

    const byUsername = new Map<string, ProfileFetchOutcome>();
    for (const rawOutcome of outcomes) {
        const outcome = profileFetchOutcomeSchema.parse(rawOutcome);
        if (!requestedSet.has(outcome.requestedUsername)) {
            throw new Error('PROFILE_FETCH_OUTCOME_ERROR: unexpected outcome username.');
        }
        if (byUsername.has(outcome.requestedUsername)) {
            throw new Error('PROFILE_FETCH_OUTCOME_ERROR: duplicate outcome username.');
        }
        byUsername.set(outcome.requestedUsername, outcome);
    }

    const failureCounts: ProfileFetchOutcomeSummary['failureCounts'] = {};
    let succeeded = 0;
    let unavailable = 0;
    let failed = 0;
    const unresolvedUsernames: string[] = [];

    for (const username of requested) {
        const outcome = byUsername.get(username);
        if (!outcome) {
            throw new Error(
                `PROFILE_FETCH_OUTCOME_ERROR: missing terminal outcome for ${username}.`
            );
        }
        if (outcome.status === 'success') {
            succeeded += 1;
            continue;
        }

        unresolvedUsernames.push(username);
        failureCounts[outcome.failureCategory] =
            (failureCounts[outcome.failureCategory] ?? 0) + 1;
        if (outcome.status === 'unavailable') unavailable += 1;
        else failed += 1;
    }

    return {
        requested: requested.length,
        succeeded,
        unavailable,
        failed,
        unresolvedUsernames,
        failureCounts,
    };
}
