export const RESULT_PAGE_SIZE_DEFAULT = 24;
export const RESULT_PAGE_SIZE_MAX = 50;
export const RESULT_CURSOR_VERSION = 1;

export type ResultListKind = 'public' | 'private';
export type ResultSortDirection = 'asc' | 'desc';
export type ResultSortKey = string | number;
export type ResultSortKeyType = 'string' | 'number';

export interface ResultCursorPayload {
    version: typeof RESULT_CURSOR_VERSION;
    list: ResultListKind;
    direction: ResultSortDirection;
    sortKeyType: ResultSortKeyType;
    sortKey: ResultSortKey;
    candidateId: string;
}

export interface ResultPaginationOptions<T> {
    list: ResultListKind;
    direction: ResultSortDirection;
    sortKeyType: ResultSortKeyType;
    getSortKey: (item: T) => ResultSortKey;
    getCandidateId: (item: T) => string;
    cursor?: string | null;
    pageSize?: number;
}

export interface ResultPage<T> {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
    pageSize: number;
}

export class ResultPaginationError extends Error {
    constructor(
        public readonly code:
            | 'INVALID_CURSOR'
            | 'CURSOR_SCOPE_MISMATCH'
            | 'INVALID_PAGE_SIZE'
            | 'INVALID_ITEM'
    ) {
        super(code);
        this.name = 'ResultPaginationError';
    }
}

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const SAFE_OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PAYLOAD_KEYS = [
    'candidateId',
    'direction',
    'list',
    'sortKey',
    'sortKeyType',
    'version',
] as const;

function invalidCursor(): never {
    throw new ResultPaginationError('INVALID_CURSOR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactPayloadKeys(value: Record<string, unknown>): boolean {
    const keys = Object.keys(value).sort();
    return keys.length === PAYLOAD_KEYS.length
        && keys.every((key, index) => key === PAYLOAD_KEYS[index]);
}

function isSafeOpaqueValue(value: unknown): value is string {
    return typeof value === 'string' && SAFE_OPAQUE_VALUE_PATTERN.test(value);
}

function isValidSortKey(value: unknown, type: ResultSortKeyType):
value is ResultSortKey {
    if (type === 'number') {
        return typeof value === 'number'
            && Number.isFinite(value)
            && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
    }
    return isSafeOpaqueValue(value);
}

function validatePayload(value: unknown): ResultCursorPayload {
    if (!isRecord(value) || !hasExactPayloadKeys(value)) invalidCursor();
    if (value.version !== RESULT_CURSOR_VERSION) invalidCursor();
    if (value.list !== 'public' && value.list !== 'private') invalidCursor();
    if (value.direction !== 'asc' && value.direction !== 'desc') invalidCursor();
    if (value.sortKeyType !== 'string' && value.sortKeyType !== 'number') invalidCursor();
    if (!isValidSortKey(value.sortKey, value.sortKeyType)) invalidCursor();
    if (!isSafeOpaqueValue(value.candidateId)) invalidCursor();

    return {
        version: RESULT_CURSOR_VERSION,
        list: value.list,
        direction: value.direction,
        sortKeyType: value.sortKeyType,
        sortKey: value.sortKey,
        candidateId: value.candidateId,
    };
}

function payloadJson(payload: ResultCursorPayload): string {
    return JSON.stringify({
        version: payload.version,
        list: payload.list,
        direction: payload.direction,
        sortKeyType: payload.sortKeyType,
        sortKey: payload.sortKey,
        candidateId: payload.candidateId,
    });
}

function encodeBase64Url(value: string): string {
    return btoa(value)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): string {
    const base64 = value
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
    return atob(base64);
}

export function encodeResultCursor(payload: ResultCursorPayload): string {
    const validated = validatePayload(payload);
    return encodeBase64Url(payloadJson(validated));
}

export function decodeResultCursor(cursor: string): ResultCursorPayload {
    if (!CURSOR_PATTERN.test(cursor)) invalidCursor();

    try {
        const json = decodeBase64Url(cursor);
        const payload = validatePayload(JSON.parse(json) as unknown);
        if (encodeResultCursor(payload) !== cursor) invalidCursor();
        return payload;
    } catch (error) {
        if (error instanceof ResultPaginationError) throw error;
        return invalidCursor();
    }
}

function resolvePageSize(value: number | undefined): number {
    if (value === undefined) return RESULT_PAGE_SIZE_DEFAULT;
    if (!Number.isSafeInteger(value) || value < 1 || value > RESULT_PAGE_SIZE_MAX) {
        throw new ResultPaginationError('INVALID_PAGE_SIZE');
    }
    return value;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function compareSortKeys(
    left: ResultSortKey,
    right: ResultSortKey,
    type: ResultSortKeyType,
    direction: ResultSortDirection
): number {
    const comparison = type === 'number'
        ? (left as number) - (right as number)
        : compareStrings(left as string, right as string);
    if (comparison === 0) return 0;
    return direction === 'asc' ? comparison : -comparison;
}

function compareTuple(
    left: { sortKey: ResultSortKey; candidateId: string },
    right: { sortKey: ResultSortKey; candidateId: string },
    type: ResultSortKeyType,
    direction: ResultSortDirection
): number {
    return compareSortKeys(left.sortKey, right.sortKey, type, direction)
        || compareStrings(left.candidateId, right.candidateId);
}

interface IndexedResult<T> {
    item: T;
    sortKey: ResultSortKey;
    candidateId: string;
}

function indexItems<T>(
    items: readonly T[],
    options: ResultPaginationOptions<T>
): IndexedResult<T>[] {
    const candidateIds = new Set<string>();
    return items.map(item => {
        const sortKey = options.getSortKey(item);
        const candidateId = options.getCandidateId(item);
        if (
            !isValidSortKey(sortKey, options.sortKeyType)
            || !isSafeOpaqueValue(candidateId)
            || candidateIds.has(candidateId)
        ) {
            throw new ResultPaginationError('INVALID_ITEM');
        }
        candidateIds.add(candidateId);
        return { item, sortKey, candidateId };
    });
}

function scopedCursor<T>(
    cursor: string | null | undefined,
    options: ResultPaginationOptions<T>
): ResultCursorPayload | null {
    if (!cursor) return null;
    const payload = decodeResultCursor(cursor);
    if (
        payload.list !== options.list
        || payload.direction !== options.direction
        || payload.sortKeyType !== options.sortKeyType
    ) {
        throw new ResultPaginationError('CURSOR_SCOPE_MISMATCH');
    }
    return payload;
}

/**
 * Deterministically paginates a bounded result collection. The cursor contains only the
 * derived ordering tuple and never serializes the result item or its evidence fields.
 */
export function paginateAnalysisResults<T>(
    items: readonly T[],
    options: ResultPaginationOptions<T>
): ResultPage<T> {
    const pageSize = resolvePageSize(options.pageSize);
    const cursor = scopedCursor(options.cursor, options);
    const indexed = indexItems(items, options).sort((left, right) => compareTuple(
        left,
        right,
        options.sortKeyType,
        options.direction
    ));
    const remaining = cursor
        ? indexed.filter(item => compareTuple(
            item,
            cursor,
            options.sortKeyType,
            options.direction
        ) > 0)
        : indexed;
    const page = remaining.slice(0, pageSize);
    const hasMore = remaining.length > page.length;
    const last = page.at(-1);
    const nextCursor = hasMore && last
        ? encodeResultCursor({
            version: RESULT_CURSOR_VERSION,
            list: options.list,
            direction: options.direction,
            sortKeyType: options.sortKeyType,
            sortKey: last.sortKey,
            candidateId: last.candidateId,
        })
        : null;

    return {
        items: page.map(entry => entry.item),
        nextCursor,
        hasMore,
        pageSize,
    };
}
