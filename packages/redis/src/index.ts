import { createHash } from 'node:crypto';
import {
  UsageStateError,
  type Budget,
  type MarkLiableInput,
  type MarkLiableResult,
  type RenewInput,
  type RenewResult,
  type SettleInput,
  type SettlementResult,
  type StoreReserveResult,
  type UsageRequest,
  type UsageStore,
} from '@mcp-usage-control/core';
import { MARK_LIABLE_SCRIPT, RENEW_SCRIPT, RESERVE_SCRIPT, SETTLE_SCRIPT } from './scripts.js';

export interface RedisEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export interface RedisUsageStoreOptions {
  /** Key prefix. Braces are rejected so the configured Redis hash tag stays authoritative. */
  prefix?: string;
  /** All transactional keys use this Redis Cluster hash tag. Defaults to `usage`. */
  hashTag?: string;
  /** Maximum expired reservations/tombstones reclaimed by one reserve call. */
  cleanupBatchSize?: number;
  /** How long a settled operation remains protected from replay. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
}

interface RedisKeys {
  used: string;
  pending: string;
  reservations: string;
  operations: string;
  tombstones: string;
}

interface ParsedReservationId {
  budgetHash: string;
}

const RESERVATION_ID_PATTERN = /^r1\.([a-f0-9]{64})\.([a-f0-9]{64})$/;

export class RedisUsageStore implements UsageStore {
  private readonly prefix: string;
  private readonly hashTag: string;
  private readonly cleanupBatchSize: number;
  private readonly idempotencyTtlMs: number;

  constructor(
    private readonly client: RedisEvalClient,
    options: RedisUsageStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'muc';
    this.hashTag = options.hashTag ?? 'usage';
    this.cleanupBatchSize = options.cleanupBatchSize ?? 256;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;

    if (this.prefix.includes('{') || this.prefix.includes('}')) {
      throw new RangeError('prefix must not contain Redis hash-tag braces');
    }
    if (this.hashTag.length === 0 || this.hashTag.includes('{') || this.hashTag.includes('}')) {
      throw new RangeError('hashTag must be non-empty and must not contain braces');
    }
    assertPositiveInteger(this.cleanupBatchSize, 'cleanupBatchSize');
    assertPositiveInteger(this.idempotencyTtlMs, 'idempotencyTtlMs');
  }

  async reserve(input: {
    request: UsageRequest;
    units: number;
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    assertNonNegativeInteger(input.units, 'units');
    assertNonNegativeInteger(input.budget.limit, 'budget.limit');
    assertPositiveInteger(input.ttlMs, 'ttlMs');

    const budgetHash = digest(input.budget.key);
    const operationKey = digest(JSON.stringify([input.request.principal.id, input.request.operationId]));
    const reservationId = `r1.${budgetHash}.${operationKey}`;
    const keys = this.keys(budgetHash);

    const reply = parseReply(
      await this.client.eval(RESERVE_SCRIPT, {
        keys: [keys.used, keys.pending, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          String(input.units),
          String(input.budget.limit),
          String(input.ttlMs),
          reservationId,
          operationKey,
          String(this.cleanupBatchSize),
          String(this.idempotencyTtlMs),
        ],
      }),
    );

    switch (reply[0]) {
      case 'accepted': {
        const expiresAt = parseInteger(reply[2], 'expiresAt');
        return {
          accepted: true,
          reservation: {
            id: reservationId,
            operationId: input.request.operationId,
            principalId: input.request.principal.id,
            tool: input.request.tool,
            budgetKey: input.budget.key,
            reservedUnits: input.units,
            expiresAt,
          },
          remaining: parseInteger(reply[1], 'remaining'),
        };
      }
      case 'quota_exceeded':
        return {
          accepted: false,
          reason: 'quota_exceeded',
          remaining: parseInteger(reply[1], 'remaining'),
        };
      case 'duplicate_operation':
        return { accepted: false, reason: 'duplicate_operation' };
      default:
        throw new UsageStateError(`Unexpected Redis reserve reply: ${reply[0] ?? '<empty>'}`);
    }
  }

  async markLiable(input: MarkLiableInput): Promise<MarkLiableResult> {
    const { budgetHash } = parseReservationId(input.reservationId);
    const keys = this.keys(budgetHash);
    const reply = parseReply(
      await this.client.eval(MARK_LIABLE_SCRIPT, {
        keys: [keys.used, keys.pending, keys.reservations, keys.operations, keys.tombstones],
        arguments: [input.reservationId, String(this.idempotencyTtlMs)],
      }),
    );

    if (reply[0] === 'marked') {
      return {
        reservationId: input.reservationId,
        expiresAt: parseInteger(reply[1], 'expiresAt'),
      };
    }
    if (reply[0] === 'expired' || reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Active reservation not found or expired');
    }
    throw new UsageStateError(`Unexpected Redis mark-liable reply: ${reply[0] ?? '<empty>'}`);
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const { budgetHash } = parseReservationId(input.reservationId);
    const keys = this.keys(budgetHash);

    const reply = parseReply(
      await this.client.eval(RENEW_SCRIPT, {
        keys: [keys.used, keys.pending, keys.reservations, keys.operations, keys.tombstones],
        arguments: [String(input.ttlMs), input.reservationId, String(this.idempotencyTtlMs)],
      }),
    );

    if (reply[0] === 'renewed') {
      return {
        reservationId: input.reservationId,
        expiresAt: parseInteger(reply[1], 'expiresAt'),
      };
    }

    if (reply[0] === 'expired' || reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Active reservation not found or expired');
    }

    throw new UsageStateError(`Unexpected Redis renew reply: ${reply[0] ?? '<empty>'}`);
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    const { budgetHash } = parseReservationId(input.reservationId);
    const keys = this.keys(budgetHash);

    const reply = parseReply(
      await this.client.eval(SETTLE_SCRIPT, {
        keys: [keys.used, keys.pending, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          input.reservationId,
          String(input.actualUnits),
          input.outcome,
          String(this.idempotencyTtlMs),
        ],
      }),
    );

    if (reply[0] === 'settled' || reply[0] === 'idempotent') {
      return {
        reservationId: input.reservationId,
        reservedUnits: parseInteger(reply[1], 'reservedUnits'),
        actualUnits: parseInteger(reply[2], 'actualUnits'),
        releasedUnits: parseInteger(reply[3], 'releasedUnits'),
        outcome: input.outcome,
      };
    }

    if (reply[0] === 'conflict') {
      throw new UsageStateError('Reservation was already settled with a different result');
    }
    if (reply[0] === 'invalid_units') {
      throw new UsageStateError('actualUnits cannot exceed reservedUnits');
    }
    if (reply[0] === 'expired' || reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }

    throw new UsageStateError(`Unexpected Redis settle reply: ${reply[0] ?? '<empty>'}`);
  }

  private keys(budgetHash: string): RedisKeys {
    const base = `${this.prefix}:{${this.hashTag}}`;
    return {
      used: `${base}:budget:${budgetHash}:used`,
      pending: `${base}:budget:${budgetHash}:pending`,
      reservations: `${base}:reservations`,
      operations: `${base}:operations`,
      tombstones: `${base}:tombstones`,
    };
  }
}

function parseReservationId(reservationId: string): ParsedReservationId {
  const match = RESERVATION_ID_PATTERN.exec(reservationId);
  if (!match?.[1]) throw new UsageStateError('Invalid Redis reservation ID');
  return { budgetHash: match[1] };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseReply(value: unknown): string[] {
  if (!Array.isArray(value)) throw new UsageStateError('Redis script returned a non-array reply');
  return value.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part === 'number' || typeof part === 'bigint') return String(part);
    if (part instanceof Uint8Array) return Buffer.from(part).toString('utf8');
    throw new UsageStateError('Redis script returned an unsupported reply value');
  });
}

function parseInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new UsageStateError(`Redis script returned an invalid ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageStateError(`Redis script returned an unsafe ${name}`);
  }
  return parsed;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
