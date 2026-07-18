const PENDING_TARGET_KEY = 'pending_ig';
const PENDING_TARGET_TTL_MS = 30 * 60_000;
const TARGET_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export type PendingTargetStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

interface StoredPendingTarget {
    stored_at: number;
    target: string;
}

function normalizePendingTarget(value: string): string | null {
    const normalized = value.trim().replace(/^@+/, '');
    if (!TARGET_PATTERN.test(normalized)) return null;
    if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) return null;
    return normalized;
}

export function clearPendingAnalysisTarget(storage: PendingTargetStorage): void {
    try {
        storage.removeItem(PENDING_TARGET_KEY);
    } catch {
        // Session handoff is best-effort and must not interrupt navigation.
    }
}

export function storePendingAnalysisTarget(
    storage: PendingTargetStorage,
    target: string,
    now = Date.now(),
): boolean {
    const normalized = normalizePendingTarget(target);
    if (!normalized || !Number.isSafeInteger(now)) return false;

    try {
        storage.setItem(PENDING_TARGET_KEY, JSON.stringify({
            stored_at: now,
            target: normalized,
        } satisfies StoredPendingTarget));
        return true;
    } catch {
        return false;
    }
}

export function readPendingAnalysisTarget(
    storage: PendingTargetStorage,
    now = Date.now(),
): string | null {
    try {
        const raw = storage.getItem(PENDING_TARGET_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            clearPendingAnalysisTarget(storage);
            return null;
        }

        const storedAt = Reflect.get(parsed, 'stored_at');
        const target = Reflect.get(parsed, 'target');
        const normalized = typeof target === 'string' ? normalizePendingTarget(target) : null;
        const age = typeof storedAt === 'number' ? now - storedAt : Number.NaN;
        if (!normalized || !Number.isSafeInteger(storedAt) || age < 0 || age > PENDING_TARGET_TTL_MS) {
            clearPendingAnalysisTarget(storage);
            return null;
        }
        return normalized;
    } catch {
        clearPendingAnalysisTarget(storage);
        return null;
    }
}
