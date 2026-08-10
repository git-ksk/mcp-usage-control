import { describe, expect, it } from 'vitest';
import type { DurableObjectStorage, SqlStorageValue } from 'cloudflare:workers';
import { lookupCloudflareReservation } from './reconciliation-protocol.js';

type Row = Record<string, SqlStorageValue>;

const reservationId = `cf1.${'a'.repeat(64)}`;
const budgetId = 'b'.repeat(64);

function storageFor(row?: Row) {
  const queries: string[] = [];
  const storage = {
    sql: {
      exec<T extends Row = Row>(query: string) {
        queries.push(query.trim());
        return {
          toArray: () => (row ? [{ ...row }] : []) as unknown as T[],
          one: () => {
            if (!row) throw new Error('no row');
            return { ...row } as unknown as T;
          },
          *[Symbol.iterator]() {
            if (row) yield { ...row } as unknown as T;
          },
        };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return callback();
    },
  } as unknown as DurableObjectStorage;
  return { storage, queries };
}

function activeRow(overrides: Row = {}): Row {
  return {
    id: reservationId,
    state: 'pending',
    reserved_units: 2,
    expires_at: 2_000,
    actual_units: null,
    terminal_reason: null,
    tombstone_expires_at: null,
    budget_ids_json: JSON.stringify([budgetId]),
    ...overrides,
  };
}

describe('Cloudflare reserve reconciliation lookup', () => {
  it('returns absent without mutating storage', () => {
    const { storage, queries } = storageFor();
    expect(lookupCloudflareReservation(storage, { reservationId }, 1_000)).toEqual({
      status: 'absent',
    });
    expect(queries).toHaveLength(1);
    expect(queries.every(query => /^select\b/i.test(query))).toBe(true);
  });

  it('returns active pending state without changing quota', () => {
    const { storage, queries } = storageFor(activeRow());
    expect(lookupCloudflareReservation(storage, { reservationId }, 1_000)).toEqual({
      status: 'active',
      state: 'pending',
      reservationId,
      reservedUnits: 2,
      expiresAt: 2_000,
      budgetIds: [budgetId],
    });
    expect(queries.every(query => /^select\b/i.test(query))).toBe(true);
  });

  it('reports active liable state without converting it', () => {
    const { storage } = storageFor(activeRow({ state: 'liable' }));
    expect(lookupCloudflareReservation(storage, { reservationId }, 1_000)).toMatchObject({
      status: 'active',
      state: 'liable',
    });
  });

  it('reports an expired pending row but leaves normal recovery to enforcement operations', () => {
    const { storage, queries } = storageFor(activeRow({ expires_at: 900 }));
    expect(lookupCloudflareReservation(storage, { reservationId }, 1_000)).toEqual({
      status: 'expired',
      state: 'pending',
      reservationId,
      reservedUnits: 2,
      expiredAt: 900,
      budgetIds: [budgetId],
    });
    expect(queries.every(query => /^select\b/i.test(query))).toBe(true);
  });

  it('reports a normal settlement tombstone', () => {
    const { storage } = storageFor(
      activeRow({
        state: 'settled',
        actual_units: 1,
        tombstone_expires_at: 5_000,
      }),
    );
    expect(lookupCloudflareReservation(storage, { reservationId }, 1_000)).toEqual({
      status: 'settled',
      reservationId,
      reservedUnits: 2,
      actualUnits: 1,
      tombstoneExpiresAt: 5_000,
      budgetIds: [budgetId],
    });
  });

  it('maps conservative liable-expiry tombstones to expired liable state', () => {
    const { storage } = storageFor(
      activeRow({
        state: 'settled',
        actual_units: 2,
        terminal_reason: 'lease_expired_after_execution_started',
        tombstone_expires_at: 5_000,
        expires_at: 900,
      }),
    );
    expect(lookupCloudflareReservation(storage, { reservationId }, 1_000)).toEqual({
      status: 'expired',
      state: 'liable',
      reservationId,
      reservedUnits: 2,
      expiredAt: 900,
      budgetIds: [budgetId],
    });
  });
});
