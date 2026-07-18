import { PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD } from '../lib/services/analysis/profile-provider-canary-run-store';

export const PROFILE_PROVIDER_CANARY_REPEATS = 2;
export const PROFILE_PROVIDER_CANARY_MAX_RUN_USD = 0.05;
export const PROFILE_PROVIDER_CANARY_MAX_TOTAL_USD = 0.10;
export const PROFILE_PROVIDER_CANARY_MAX_OBSERVED_TOTAL_USD = 1.05;
export const PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT = 15;
export const PROFILE_PROVIDER_CANARY_MAX_LATENCY_MS = 60_000;
export const PROFILE_PROVIDER_CANARY_MAX_REPORTED_LATENCY_MS = 300_000;

const SOURCE_REQUEST_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FIXED_PAID_OPTIONS = new Set([
    '--repeats',
    '--max-run-usd',
    '--max-total-usd',
    '--actor-id',
    '--actor-build',
    '--credential-slot',
]);

export interface InstagramProfileProviderCanaryOptions {
    sourceRequestId: string;
    confirmPaidApiCall: boolean;
    repetitions: number;
    maximumRunChargeUsd: number;
    maximumTotalChargeUsd: number;
}

export function parseInstagramProfileProviderCanaryArgs(
    args: readonly string[]
): InstagramProfileProviderCanaryOptions {
    let sourceRequestId: string | null = null;
    let paidConfirmationCount = 0;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];

        if (argument === '--source-request-id') {
            if (sourceRequestId !== null) {
                throw new Error('--source-request-id must be provided exactly once');
            }
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--source-request-id is required');
            }
            sourceRequestId = value;
            index += 1;
            continue;
        }

        if (argument === '--confirm-paid-api-call') {
            paidConfirmationCount += 1;
            if (paidConfirmationCount > 1) {
                throw new Error('--confirm-paid-api-call must appear exactly once');
            }
            continue;
        }

        if (argument.startsWith('--confirm-paid-api-call=')) {
            throw new Error('--confirm-paid-api-call must be exact and valueless');
        }

        const optionName = argument.split('=', 1)[0];
        if (FIXED_PAID_OPTIONS.has(optionName)) {
            throw new Error('the paid actor, build, credential, and limits use a fixed paid identity');
        }

        throw new Error(`unknown argument: ${argument}`);
    }

    if (sourceRequestId === null) {
        throw new Error('--source-request-id is required');
    }
    if (!SOURCE_REQUEST_ID_PATTERN.test(sourceRequestId)) {
        throw new Error('invalid arguments: --source-request-id must be a canonical UUID');
    }

    const confirmPaidApiCall = paidConfirmationCount === 1;
    return {
        sourceRequestId,
        confirmPaidApiCall,
        repetitions: confirmPaidApiCall ? PROFILE_PROVIDER_CANARY_REPEATS : 0,
        maximumRunChargeUsd: confirmPaidApiCall ? PROFILE_PROVIDER_CANARY_MAX_RUN_USD : 0,
        maximumTotalChargeUsd: confirmPaidApiCall ? PROFILE_PROVIDER_CANARY_MAX_TOTAL_USD : 0,
    };
}

type UnknownRecord = Record<string, unknown>;

export interface SanitizedInstagramProfileProviderCanaryRun {
    repetition: number;
    lifecycle_status: string;
    terminal_count: number;
    success_count: number;
    unavailable_count: number;
    incomplete_count: number;
    other_failure_count: number;
    latency_ms: number;
    build_matched: boolean;
    restricted_access: boolean;
    actual_cost_usd: number | null;
    cost_status: string;
    cleanup: {
        key_value_store: boolean;
        dataset: boolean;
        request_queue: boolean;
    };
    gate_passed: boolean;
}

export interface SanitizedInstagramProfileProviderCanaryResult {
    mode: string;
    source_run_count: number;
    requested_count: number;
    critical_incomplete_count: number;
    runs: SanitizedInstagramProfileProviderCanaryRun[];
    total_actual_cost_usd: number | null;
    session_maximum_exposure_usd: number;
    cost_status: string;
    source_cleanup_complete: boolean;
    experiment_terminal: boolean;
    gate_passed: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
    return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isBoundedMoney(value: unknown, maximum: number): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 0
        && value <= maximum;
}

function invalidReport(): never {
    throw new Error('invalid report');
}

const REPORT_MODES = new Set(['replay', 'paid_canary']);
const LIFECYCLE_STATUSES = new Set([
    'reserved', 'running', 'ambiguous', 'succeeded', 'failed',
]);
const COST_STATUSES = new Set(['actual', 'conservative', 'unknown']);

function sanitizeRun(value: unknown): SanitizedInstagramProfileProviderCanaryRun {
    if (!isRecord(value)) invalidReport();

    const repetition = value.repetition;
    const terminalCount = value.terminalCount;
    const successCount = value.successCount;
    const unavailableCount = value.unavailableCount;
    const incompleteCount = value.incompleteCount;
    const otherFailureCount = value.otherFailureCount;
    const actualCostUsd = value.actualCostUsd;
    const cleanup = value.cleanup;

    if (!isBoundedInteger(repetition, 1, PROFILE_PROVIDER_CANARY_REPEATS)
        || typeof value.lifecycleStatus !== 'string'
        || !LIFECYCLE_STATUSES.has(value.lifecycleStatus)
        || !isBoundedInteger(terminalCount, 0, PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT)
        || !isBoundedInteger(successCount, 0, PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT)
        || !isBoundedInteger(unavailableCount, 0, PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT)
        || !isBoundedInteger(incompleteCount, 0, PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT)
        || !isBoundedInteger(otherFailureCount, 0, PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT)
        || successCount + unavailableCount + incompleteCount + otherFailureCount !== terminalCount
        || !isBoundedInteger(value.latencyMs, 0, PROFILE_PROVIDER_CANARY_MAX_REPORTED_LATENCY_MS)
        || typeof value.buildMatched !== 'boolean'
        || typeof value.restrictedAccess !== 'boolean'
        || !(actualCostUsd === null
            || isBoundedMoney(actualCostUsd, PROFILE_PROVIDER_CANARY_MAX_OBSERVED_USAGE_USD))
        || typeof value.costStatus !== 'string'
        || !COST_STATUSES.has(value.costStatus)
        || !isRecord(cleanup)
        || typeof cleanup.keyValueStore !== 'boolean'
        || typeof cleanup.dataset !== 'boolean'
        || typeof cleanup.requestQueue !== 'boolean'
        || typeof value.gatePassed !== 'boolean') {
        invalidReport();
    }

    const hasActualCost = actualCostUsd !== null;
    const cleanupComplete = cleanup.keyValueStore && cleanup.dataset && cleanup.requestQueue;
    const cleanupStarted = cleanup.keyValueStore || cleanup.dataset || cleanup.requestQueue;
    if ((value.costStatus === 'actual') !== hasActualCost
        || (cleanupStarted && !hasActualCost)
        || (value.gatePassed === true && (
            value.lifecycleStatus !== 'succeeded'
            || terminalCount !== PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT
            || successCount !== PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT
            || unavailableCount !== 0
            || incompleteCount !== 0
            || otherFailureCount !== 0
            || value.latencyMs > PROFILE_PROVIDER_CANARY_MAX_LATENCY_MS
            || value.buildMatched !== true
            || value.restrictedAccess !== true
        ))
        || (cleanupComplete && value.lifecycleStatus !== 'succeeded' && value.lifecycleStatus !== 'failed')) {
        invalidReport();
    }

    return {
        repetition,
        lifecycle_status: value.lifecycleStatus,
        terminal_count: terminalCount,
        success_count: successCount,
        unavailable_count: unavailableCount,
        incomplete_count: incompleteCount,
        other_failure_count: otherFailureCount,
        latency_ms: value.latencyMs,
        build_matched: value.buildMatched,
        restricted_access: value.restrictedAccess,
        actual_cost_usd: actualCostUsd,
        cost_status: value.costStatus,
        cleanup: {
            key_value_store: cleanup.keyValueStore,
            dataset: cleanup.dataset,
            request_queue: cleanup.requestQueue,
        },
        gate_passed: value.gatePassed,
    };
}

export function sanitizeInstagramProfileProviderCanaryResult(
    value: unknown
): SanitizedInstagramProfileProviderCanaryResult {
    if (!isRecord(value)
        || typeof value.mode !== 'string'
        || !REPORT_MODES.has(value.mode)
        || !isBoundedInteger(value.sourceRunCount, 0, 8)
        || value.requestedCount !== PROFILE_PROVIDER_CANARY_EXPECTED_INPUT_COUNT
        || value.criticalIncompleteCount !== 3
        || !Array.isArray(value.runs)
        || value.runs.length > PROFILE_PROVIDER_CANARY_REPEATS
        || !(value.totalActualCostUsd === null
            || isBoundedMoney(
                value.totalActualCostUsd,
                PROFILE_PROVIDER_CANARY_MAX_OBSERVED_TOTAL_USD
            ))
        || !isBoundedMoney(value.sessionMaximumExposureUsd, PROFILE_PROVIDER_CANARY_MAX_TOTAL_USD)
        || typeof value.costStatus !== 'string'
        || !COST_STATUSES.has(value.costStatus)
        || typeof value.sourceCleanupComplete !== 'boolean'
        || typeof value.experimentTerminal !== 'boolean'
        || typeof value.gatePassed !== 'boolean') {
        invalidReport();
    }

    const runs = value.runs.map(sanitizeRun);
    if (new Set(runs.map(run => run.repetition)).size !== runs.length) {
        invalidReport();
    }

    const allRunCostsActual = runs.every(run => run.cost_status === 'actual');
    const summedActualCost = runs.reduce(
        (total, run) => total + (run.actual_cost_usd ?? 0),
        0
    );
    const fullyGated = runs.length === PROFILE_PROVIDER_CANARY_REPEATS
        && runs.every(run => run.gate_passed)
        && runs.every(run => (
            run.cleanup.key_value_store
            && run.cleanup.dataset
            && run.cleanup.request_queue
        ));
    if ((value.costStatus === 'actual') !== (value.totalActualCostUsd !== null)
        || (value.costStatus === 'actual' && !allRunCostsActual)
        || (value.totalActualCostUsd !== null
            && Math.abs(value.totalActualCostUsd - summedActualCost) > Number.EPSILON)
        || (value.sourceCleanupComplete && !value.experimentTerminal)
        || (value.gatePassed === true && (
            !fullyGated
            || !value.sourceCleanupComplete
            || !value.experimentTerminal
            || value.costStatus !== 'actual'
        ))) {
        invalidReport();
    }

    if (value.mode === 'replay' && (
        runs.length !== 0
        || value.sessionMaximumExposureUsd !== 0
        || value.totalActualCostUsd !== 0
        || value.costStatus !== 'actual'
        || value.sourceCleanupComplete
        || value.experimentTerminal
        || value.gatePassed
    )) {
        invalidReport();
    }

    return {
        mode: value.mode,
        source_run_count: value.sourceRunCount,
        requested_count: value.requestedCount,
        critical_incomplete_count: value.criticalIncompleteCount,
        runs,
        total_actual_cost_usd: value.totalActualCostUsd,
        session_maximum_exposure_usd: value.sessionMaximumExposureUsd,
        cost_status: value.costStatus,
        source_cleanup_complete: value.sourceCleanupComplete,
        experiment_terminal: value.experimentTerminal,
        gate_passed: value.gatePassed,
    };
}
