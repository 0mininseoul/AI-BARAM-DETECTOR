import { describe, expect, it, vi } from 'vitest';
import {
    clearPendingAnalysisTarget,
    readPendingAnalysisTarget,
    storePendingAnalysisTarget,
} from './pending-analysis-target';

const NOW = 1_750_000_000_000;

function createStorage() {
    const values = new Map<string, string>();
    return {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
}

describe('pending analysis target handoff', () => {
    it('normalizes and reloads a bounded session-only target', () => {
        const storage = createStorage();

        expect(storePendingAnalysisTarget(storage, '  @safe.handle_1  ', NOW)).toBe(true);
        expect(readPendingAnalysisTarget(storage, NOW + 60_000)).toBe('safe.handle_1');
        expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
            stored_at: NOW,
            target: 'safe.handle_1',
        });
    });

    it.each([
        '',
        '@',
        'a'.repeat(31),
        'has spaces',
        'https://example.com',
        'person@example.com',
    ])('rejects unsafe or unbounded target %j', (target) => {
        const storage = createStorage();

        expect(storePendingAnalysisTarget(storage, target, NOW)).toBe(false);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('expires and removes a stale or malformed handoff', () => {
        const storage = createStorage();
        storePendingAnalysisTarget(storage, 'safe_handle', NOW);

        expect(readPendingAnalysisTarget(storage, NOW + 30 * 60_000 + 1)).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith('pending_ig');

        storage.setItem('pending_ig', 'legacy-raw-target');
        expect(readPendingAnalysisTarget(storage, NOW)).toBeNull();
    });

    it('clears without throwing when storage is unavailable', () => {
        const storage = {
            getItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
            removeItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
            setItem: vi.fn(() => {
                throw new Error('unavailable');
            }),
        };

        expect(() => clearPendingAnalysisTarget(storage)).not.toThrow();
        expect(readPendingAnalysisTarget(storage, NOW)).toBeNull();
        expect(storePendingAnalysisTarget(storage, 'safe_handle', NOW)).toBe(false);
    });
});
