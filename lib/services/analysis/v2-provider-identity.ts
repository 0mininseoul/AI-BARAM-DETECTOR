// Leaf module for the paid-provider run identity and cost-fence primitives shared between the
// collection executors and the profile-repair adapter. It has no analysis-v2 imports of its own,
// so both `v2-collection-executors.ts` and `v2-profile-repair.ts` can depend on it without the
// executors -> repair -> executors import cycle that a shared helper in the executors would create.

/**
 * Length-prefix a string so a run's canonical identity cannot be forged by shifting a delimiter
 * across parts (e.g. `['ab', 'c']` and `['a', 'bc']` must hash differently).
 */
export function lengthPrefixed(value: string): string {
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/** Join length-prefixed parts into one canonical, injection-proof provider run identity string. */
export function canonicalProviderInput(parts: readonly string[]): string {
    return parts.map(lengthPrefixed).join('\n');
}

/**
 * Clamp and normalise an estimated provider charge. Throws `ANALYSIS_V2_COLLECTION_BUDGET_ERROR`
 * when the estimate is non-finite, negative, or over the hard maximum, and otherwise returns the
 * value rounded to 12 decimals. That rounding is load-bearing, not cosmetic: the same normalised
 * number is written to the provider-run ledger and handed to the adapter, and the adapter compares
 * the two with a strict `!==`, so both sides must flow through this one function to agree.
 */
export function checkedMaximumCharge(
    estimated: number,
    maximum: number,
    label: string
): number {
    if (!Number.isFinite(estimated) || estimated < 0 || estimated > maximum + Number.EPSILON) {
        throw new Error(`ANALYSIS_V2_COLLECTION_BUDGET_ERROR: ${label}.`);
    }
    return Number(estimated.toFixed(12));
}
