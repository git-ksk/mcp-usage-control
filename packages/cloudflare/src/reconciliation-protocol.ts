import type { DurableObjectStorage, SqlStorageValue } from 'cloudflare:workers';

const RESERVATION_ID_PATTERN = /^cf1\.[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_EXPIRED_REASON = 'lease_expired_after_execution_started';

export interface CloudflareLookupCommand {
  reservationId: string;
}

export type CloudflareLookupReply =
  | { status: 'absent' }
  | {
      status: 'active';
      state: 'pending' | 'liable';
      reservationId: string;
      reservedUnits: number;
      expiresAt: number;
      budgetIds: string[];
    }
  | {
      status: 'expired';
      state: 'pending' | 'liable';
      reservationId: string;
      reservedUnits: number;
      expiredAt: number;
      budgetIds: string[];
    }
  | {
      status: 'settled';
      reservationId: string;
      reservedUnits: number;
      actualUnits: number;
      tombstoneExpiresAt: number;
      budgetIds: string[];
    };

type LookupRow = Record<string, SqlStorageValue> & {
  id: string;
  state: string;
  reserved_units: number;
  expires_at: number;
  actual_units: number | null;
  terminal_reason: string | null;
  tombstone_expires_at: number | null;
  budget_ids_json: string;
};

/**
 * Read-only lookup used only for ambiguous reserve acknowledgement recovery.
 * It does not reserve, release, renew, settle, or otherwise change quota state.
 */
export function lookupCloudflareReservation(
  storage: DurableObjectStorage,
  command: CloudflareLookupCommand,
  now = Date.now(),
): CloudflareLookupReply {
  validateReservationId(command.reservationId);

  const row = storage.sql
    .exec<LookupRow>(
      `SELECT id, state, reserved_units, expires_at, actual_units,
              terminal_reason, tombstone_expires_at, budget_ids_json
       FROM reservations WHERE id = ?`,
      command.reservationId,
    )
    .toArray()[0];

  if (!row) return { status: 'absent' };

  const reservationId = String(row.id);
  validateReservationId(reservationId);
  const reservedUnits = integer(row.reserved_units, 'reservedUnits');
  const budgetIds = parseBudgetIds(row.budget_ids_json);
  const expiresAt = integer(row.expires_at, 'expiresAt');

  if (row.state === 'pending' || row.state === 'liable') {
    if (expiresAt <= now) {
      return {
        status: 'expired',
        state: row.state,
        reservationId,
        reservedUnits,
        expiredAt: expiresAt,
        budgetIds,
      };
    }
    return {
      status: 'active',
      state: row.state,
      reservationId,
      reservedUnits,
      expiresAt,
      budgetIds,
    };
  }

  if (row.state !== 'settled') throw new Error('Invalid stored reservation state');

  if (row.terminal_reason === LEASE_EXPIRED_REASON) {
    return {
      status: 'expired',
      state: 'liable',
      reservationId,
      reservedUnits,
      expiredAt: expiresAt,
      budgetIds,
    };
  }

  const actualUnits = nullableInteger(row.actual_units, 'actualUnits');
  const tombstoneExpiresAt = nullableInteger(row.tombstone_expires_at, 'tombstoneExpiresAt');
  return {
    status: 'settled',
    reservationId,
    reservedUnits,
    actualUnits,
    tombstoneExpiresAt,
    budgetIds,
  };
}

function validateReservationId(value: string): void {
  if (!RESERVATION_ID_PATTERN.test(value)) throw new RangeError('invalid reservationId');
}

function parseBudgetIds(raw: SqlStorageValue): string[] {
  if (typeof raw !== 'string') throw new Error('Invalid stored budget list');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored budget list');
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(id => typeof id === 'string' && HASH_PATTERN.test(id))
  ) {
    throw new Error('Invalid stored budget list');
  }
  return value;
}

function integer(value: SqlStorageValue, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid stored ${name}`);
  }
  return value;
}

function nullableInteger(value: SqlStorageValue, name: string): number {
  if (value === null) throw new Error(`Invalid stored ${name}`);
  return integer(value, name);
}
