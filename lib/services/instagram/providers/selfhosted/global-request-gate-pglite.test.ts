import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../../../supabase/migrations/20260716071911_add_selfhosted_profile_global_gate.sql',
        import.meta.url
    ),
    'utf8'
);

interface Reservation {
    schemaVersion: number;
    waitMs: number;
    reservedAt: string;
}

interface ReservationRow {
    result: Reservation;
}

let db: PGlite;

async function asRole<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function reserve(intervalMs: number): Promise<Reservation> {
    const result = await asRole<ReservationRow>(
        'service_role',
        'SELECT public.reserve_selfhosted_profile_request_start($1) AS result',
        [intervalMs]
    );
    return result.rows[0].result;
}

describe('selfhosted profile global request-start gate PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
        `);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            UPDATE public.selfhosted_profile_request_start_gate
            SET next_start_at = pg_catalog.clock_timestamp() + INTERVAL '1 second'
            WHERE singleton IS TRUE;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('advances deterministic reservations by the exact requested interval', async () => {
        const first = await reserve(750);
        const second = await reserve(750);
        const third = await reserve(750);

        expect(Object.keys(first).sort()).toEqual(['reservedAt', 'schemaVersion', 'waitMs']);
        expect(first.schemaVersion).toBe(1);
        expect(second.schemaVersion).toBe(1);
        expect(third.schemaVersion).toBe(1);
        expect(Date.parse(second.reservedAt) - Date.parse(first.reservedAt)).toBe(750);
        expect(Date.parse(third.reservedAt) - Date.parse(second.reservedAt)).toBe(750);
        expect(second.waitMs).toBeGreaterThan(first.waitMs);
        expect(third.waitMs).toBeGreaterThan(second.waitMs);
        expect(third.waitMs).toBeLessThanOrEqual(300_000);
    });

    it('rejects invalid intervals and direct table access for service_role', async () => {
        await expect(reserve(249)).rejects.toThrow();
        await expect(reserve(60_001)).rejects.toThrow();
        await expect(asRole(
            'service_role',
            'SELECT * FROM public.selfhosted_profile_request_start_gate'
        )).rejects.toThrow(/permission denied/i);
    });

    it('denies the reservation RPC to anon and authenticated roles', async () => {
        for (const role of ['anon', 'authenticated'] as const) {
            await expect(asRole(
                role,
                'SELECT public.reserve_selfhosted_profile_request_start(750)'
            )).rejects.toThrow(/permission denied/i);
        }
    });
});
