import { scoreRecentFemaleMutual } from './risk-policy';

export const RECENT_FEMALE_MUTUAL_LIMIT = 10;
export const RECENT_FEMALE_MUTUAL_BADGE_LIMIT = 5;

export type RecentFemaleMutualRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type RecentFemaleMutualBadgeRank = 1 | 2 | 3 | 4 | 5;

export interface RecentFemaleMutualAssignment {
    username: string;
    rank: RecentFemaleMutualRank;
    score: number;
    badgeRank: RecentFemaleMutualBadgeRank | null;
}

export interface RecentFemaleMutualPolicyInput {
    /** Full provider order, newest mutual first. */
    orderedMutualUsernames: readonly string[];
    /** Final public-account usernames verified as women. */
    verifiedFemaleUsernames: readonly string[];
    /** A normalized username to exclude, or null for an explicit no-exclusion decision. */
    excludedUsername: string | null;
}

const INSTAGRAM_USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

function normalizeUsername(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${field} must be an Instagram username string.`);
    }
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!INSTAGRAM_USERNAME_PATTERN.test(normalized)) {
        throw new RangeError(`${field} is not a valid Instagram username.`);
    }
    return normalized;
}

function normalizeUsernameSet(values: unknown, field: string): Set<string> {
    if (!Array.isArray(values)) {
        throw new TypeError(`${field} must be an array.`);
    }
    const normalized = new Set<string>();
    for (let index = 0; index < values.length; index++) {
        normalized.add(normalizeUsername(values[index], `${field}[${index}]`));
    }
    return normalized;
}

function normalizeOrderedUniqueUsernames(values: unknown, field: string): string[] {
    if (!Array.isArray(values)) {
        throw new TypeError(`${field} must be an array.`);
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (let index = 0; index < values.length; index++) {
        const username = normalizeUsername(values[index], `${field}[${index}]`);
        if (seen.has(username)) continue;
        seen.add(username);
        normalized.push(username);
    }
    return normalized;
}

function badgeRankFor(
    rank: RecentFemaleMutualRank
): RecentFemaleMutualBadgeRank | null {
    return rank <= RECENT_FEMALE_MUTUAL_BADGE_LIMIT
        ? rank as RecentFemaleMutualBadgeRank
        : null;
}

export function assignRecentFemaleMutuals(
    input: RecentFemaleMutualPolicyInput
): RecentFemaleMutualAssignment[] {
    if (!input || typeof input !== 'object') {
        throw new TypeError('Recent female mutual policy input is required.');
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'excludedUsername')) {
        throw new TypeError('An exclusion decision is required.');
    }

    const verifiedFemales = normalizeUsernameSet(
        input.verifiedFemaleUsernames,
        'verifiedFemaleUsernames'
    );
    const orderedMutualUsernames = normalizeOrderedUniqueUsernames(
        input.orderedMutualUsernames,
        'orderedMutualUsernames'
    );
    const excludedUsername = input.excludedUsername === null
        ? null
        : normalizeUsername(input.excludedUsername, 'excludedUsername');

    const assignments: RecentFemaleMutualAssignment[] = [];

    for (const username of orderedMutualUsernames) {
        if (username === excludedUsername || !verifiedFemales.has(username)) continue;

        const rank = (assignments.length + 1) as RecentFemaleMutualRank;
        assignments.push(Object.freeze({
            username,
            rank,
            score: scoreRecentFemaleMutual(rank),
            badgeRank: badgeRankFor(rank),
        }));

        if (assignments.length === RECENT_FEMALE_MUTUAL_LIMIT) break;
    }

    return assignments;
}
