import { createHash, randomUUID } from 'node:crypto';
import {
  UsageStateError,
  emitUsageEvent,
  type Budget,
  type BudgetRemaining,
  type GrowReservationInput,
  type MarkLiableInput,
  type ProgressiveUsageStore,
  type MarkLiableResult,
  type RenewInput,
  type RenewResult,
  type SettleInput,
  type SettlementResult,
  type StoreGrowResult,
  type StoreReserveResult,
  type UsageObserver,
  type UsageRequest,
  type UsageStore,
} from 'mcp-usage-control';
import { GROW_SCRIPT, MARK_LIABLE_SCRIPT, RENEW_SCRIPT, RESERVE_SCRIPT, SETTLE_SCRIPT } from './scripts.js';

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
  /** Optional best-effort observer for Redis expiry/recovery events. */
  observer?: UsageObserver;
}

interface RedisKeys {
  used: string;
  leases: string;
  reservations: string;
  operations: string;
  tombstones: string;
}

interface RedisRecoverySummary {
  pendingCount: number;
  pendingUnits: number;
  liableCount: number;
  liableUnits: number;
}

const RESERVATION_ID_PATTERN = /^r2\.([a-f0-9]{64})$/;

export class RedisUsageStore implements ProgressiveUsageStore {
  private readonly prefix: string;
  private readonly hashTag: string;
  private readonly cleanupBatchSize: number;
  private readonly idempotencyTtlMs: number;
  private readonly observer?: UsageObserver;

  constructor(
    private readonly client: RedisEvalClient,
    options: RedisUsageStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'muc';
    this.hashTag = options.hashTag ?? 'usage';
    this.cleanupBatchSize = options.cleanupBatchSize ?? 256;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
    this.observer = options.observer;

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
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    assertNonNegativeInteger(input.units, 'units');
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const budgets = canonicalizeBudgets(input.budgets);
    validateRequestIdentity(input.request);

    const operationKey = digest(
      JSON.stringify([
        input.request.principal.tenantId ?? null,
        input.request.principal.id,
        input.request.tool,
        input.request.operationId,
      ]),
    );
    const reservationId = `r2.${operationKey}`;
    const keys = this.keys();
    const budgetByHash = new Map<string, Budget>();
    const encodedBudgets = budgets.map(budget => {
      const hash = digest(budget.key);
      budgetByHash.set(hash, budget);
      return { hash, limit: budget.limit };
    });

    const initialGrowthCursor = newGrowthCursor();
    const parsed = parseReply(
      await this.client.eval(RESERVE_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          String(input.units),
          String(input.ttlMs),
          reservationId,
          operationKey,
          String(this.cleanupBatchSize),
          String(this.idempotencyTtlMs),
          JSON.stringify(encodedBudgets),
          initialGrowthCursor,
        ],
      }),
    );
    const { payload: reply, recovery } = extractRecovery(parsed);
    this.emitRecoverySummary(recovery);

    switch (reply[0]) {
      case 'accepted': {
        const expiresAt = parseInteger(reply[1], 'expiresAt');
        const remainingByBudget: BudgetRemaining[] = [];
        for (let index = 2; index < reply.length; index += 2) {
          const hash = reply[index];
          const remainingRaw = reply[index + 1];
          if (!hash || remainingRaw === undefined) {
            throw new UsageStateError('Redis reserve reply contained an incomplete budget balance');
          }
          const budget = budgetByHash.get(hash);
          if (!budget) throw new UsageStateError('Redis reserve reply referenced an unknown budget');
          remainingByBudget.push({
            key: budget.key,
            remaining: parseInteger(remainingRaw, `remaining (${budget.key})`),
          });
        }
        if (remainingByBudget.length !== budgets.length) {
          throw new UsageStateError('Redis reserve reply omitted a budget balance');
        }
        return {
          accepted: true,
          reservation: {
            id: reservationId,
            operationId: input.request.operationId,
            principalId: input.request.principal.id,
            ...(input.request.principal.tenantId === undefined
              ? {}
              : { tenantId: input.request.principal.tenantId }),
            ...(input.request.principal.plan === undefined
              ? {}
              : { plan: input.request.principal.plan }),
            tool: input.request.tool,
            budgetKeys: budgets.map(budget => budget.key),
            reservedUnits: input.units,
            expiresAt,
            growthCursor: initialGrowthCursor,
          },
          remainingByBudget,
        };
      }
      case 'quota_exceeded': {
        const budgetHash = reply[1];
        const remainingRaw = reply[2];
        if (!budgetHash || remainingRaw === undefined) {
          throw new UsageStateError('Redis quota reply was incomplete');
        }
        const budget = budgetByHash.get(budgetHash);
        if (!budget) throw new UsageStateError('Redis quota reply referenced an unknown budget');
        return {
          accepted: false,
          reason: 'quota_exceeded',
          limitingBudgetKey: budget.key,
          remaining: parseInteger(remainingRaw, 'remaining'),
        };
      }
      case 'duplicate_operation':
        return { accepted: false, reason: 'duplicate_operation' };
      default:
        throw new UsageStateError(`Unexpected Redis reserve reply: ${reply[0] ?? '<empty>'}`);
    }
  }

  async growReservation(input: GrowReservationInput): Promise<StoreGrowResult> {
    assertReservationId(input.reservationId);
    if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
      throw new RangeError('incrementId must be a non-empty string');
    }
    if (
      typeof input.expectedGrowthCursor !== 'string' ||
      input.expectedGrowthCursor.length === 0
    ) {
      throw new RangeError('expectedGrowthCursor must be a non-empty string');
    }
    assertPositiveInteger(input.additionalUnits, 'additionalUnits');
    const budgets = canonicalizeBudgets(input.budgets);
    const budgetByHash = new Map<string, Budget>();
    const encodedBudgets = budgets.map(budget => {
      const hash = digest(budget.key);
      budgetByHash.set(hash, budget);
      return { hash, limit: budget.limit };
    });
    const incrementHash = digest(input.incrementId);
    const fingerprint = digest(JSON.stringify([input.additionalUnits, encodedBudgets]));
    const nextGrowthCursor = newGrowthCursor();
    const keys = this.keys();

    const reply = parseReply(
      await this.client.eval(GROW_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          input.reservationId,
          incrementHash,
          input.expectedGrowthCursor,
          String(input.additionalUnits),
          String(this.idempotencyTtlMs),
          JSON.stringify(encodedBudgets),
          fingerprint,
          nextGrowthCursor,
        ],
      }),
    );

    if (reply[0] === 'accepted' || reply[0] === 'accepted_replay') {
      const returnedCursor = reply[3];
      const balancesRaw = reply[4];
      if (!returnedCursor || balancesRaw === undefined) {
        throw new UsageStateError('Redis growth reply was incomplete');
      }
      return {
        accepted: true,
        replayed: reply[0] === 'accepted_replay',
        reservationId: input.reservationId,
        incrementId: input.incrementId,
        previousReservedUnits: parseInteger(reply[1], 'previousReservedUnits'),
        reservedUnits: parseInteger(reply[2], 'reservedUnits'),
        growthCursor: returnedCursor,
        remainingByBudget: parseGrowthBalances(balancesRaw, budgetByHash),
      };
    }

    if (reply[0] === 'quota_exceeded' || reply[0] === 'quota_replay') {
      const returnedCursor = reply[1];
      const limitingHash = reply[2];
      if (!returnedCursor || !limitingHash) {
        throw new UsageStateError('Redis growth quota reply was incomplete');
      }
      const limitingBudget = budgetByHash.get(limitingHash);
      if (!limitingBudget) {
        throw new UsageStateError('Redis growth quota reply referenced an unknown budget');
      }
      return {
        accepted: false,
        reason: 'quota_exceeded',
        replayed: reply[0] === 'quota_replay',
        reservationId: input.reservationId,
        incrementId: input.incrementId,
        growthCursor: returnedCursor,
        limitingBudgetKey: limitingBudget.key,
        remaining: parseInteger(reply[3], 'remaining'),
      };
    }

    if (reply[0] === 'expired') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    if (reply[0] === 'conflict') {
      throw new UsageStateError('Growth increment was already attempted with different parameters');
    }
    if (reply[0] === 'stale_cursor') {
      throw new UsageStateError('Growth cursor is stale or conflicts with reservation state');
    }
    if (reply[0] === 'budget_mismatch') {
      throw new UsageStateError('Growth budgets must exactly match the reservation budget set');
    }
    if (reply[0] === 'not_supported') {
      throw new UsageStateError('Reservation does not support progressive growth');
    }
    if (reply[0] === 'terminal' || reply[0] === 'not_found') {
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    throw new UsageStateError(`Unexpected Redis growth reply: ${reply[0] ?? '<empty>'}`);
  }

  async markLiable(input: MarkLiableInput): Promise<MarkLiableResult> {
    assertReservationId(input.reservationId);
    const keys = this.keys();
    const reply = parseReply(
      await this.client.eval(MARK_LIABLE_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [input.reservationId, String(this.idempotencyTtlMs)],
      }),
    );

    if (reply[0] === 'marked') {
      return {
        reservationId: input.reservationId,
        expiresAt: parseInteger(reply[1], 'expiresAt'),
      };
    }
    if (reply[0] === 'expired') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Active reservation not found or expired');
    }
    if (reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Active reservation not found or expired');
    }
    throw new UsageStateError(`Unexpected Redis mark-liable reply: ${reply[0] ?? '<empty>'}`);
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    assertReservationId(input.reservationId);
    const keys = this.keys();

    const reply = parseReply(
      await this.client.eval(RENEW_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [String(input.ttlMs), input.reservationId, String(this.idempotencyTtlMs)],
      }),
    );

    if (reply[0] === 'renewed') {
      return {
        reservationId: input.reservationId,
        expiresAt: parseInteger(reply[1], 'expiresAt'),
      };
    }

    if (reply[0] === 'expired') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Active reservation not found or expired');
    }
    if (reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Active reservation not found or expired');
    }

    throw new UsageStateError(`Unexpected Redis renew reply: ${reply[0] ?? '<empty>'}`);
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    assertReservationId(input.reservationId);
    const keys = this.keys();

    const reply = parseReply(
      await this.client.eval(SETTLE_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
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
    if (reply[0] === 'expired') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    if (reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }

    throw new UsageStateError(`Unexpected Redis settle reply: ${reply[0] ?? '<empty>'}`);
  }

  private emitRecoverySummary(recovery: RedisRecoverySummary): void {
    if (recovery.pendingCount > 0) {
      emitUsageEvent(this.observer, {
        type: 'reservation.recovered',
        timestamp: Date.now(),
        store: 'redis',
        recovery: 'pending_released',
        reservedUnits: recovery.pendingUnits,
        count: recovery.pendingCount,
      });
    }
    if (recovery.liableCount > 0) {
      emitUsageEvent(this.observer, {
        type: 'reservation.recovered',
        timestamp: Date.now(),
        store: 'redis',
        recovery: 'liable_retained',
        reservedUnits: recovery.liableUnits,
        count: recovery.liableCount,
      });
    }
  }

  private emitDirectExpiry(reply: string[], reservationId: string): void {
    const state = reply[1];
    const reservedUnits = parseInteger(reply[2], 'expired reservedUnits');
    if (state !== 'pending' && state !== 'liable') return;
    emitUsageEvent(this.observer, {
      type: 'reservation.recovered',
      timestamp: Date.now(),
      store: 'redis',
      recovery: state === 'pending' ? 'pending_released' : 'liable_retained',
      reservationId,
      reservedUnits,
      count: 1,
    });
  }

  private keys(): RedisKeys {
    const base = `${this.prefix}:{${this.hashTag}}`;
    return {
      used: `${base}:used`,
      leases: `${base}:leases`,
      reservations: `${base}:reservations`,
      operations: `${base}:operations`,
      tombstones: `${base}:tombstones`,
    };
  }
}

function assertReservationId(reservationId: string): void {
  if (!RESERVATION_ID_PATTERN.test(reservationId)) {
    throw new UsageStateError('Invalid Redis reservation ID');
  }
}

function canonicalizeBudgets(budgets: readonly Budget[]): Budget[] {
  if (budgets.length === 0) throw new RangeError('budgets must contain at least one budget');
  const normalized = budgets.map(budget => {
    if (typeof budget.key !== 'string' || budget.key.length === 0) {
      throw new RangeError('budget.key must be a non-empty string');
    }
    assertNonNegativeInteger(budget.limit, `budget.limit (${budget.key})`);
    return { key: budget.key, limit: budget.limit };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.key === normalized[index]!.key) {
      throw new RangeError(`duplicate budget key: ${normalized[index]!.key}`);
    }
  }
  return normalized;
}

function validateRequestIdentity(request: UsageRequest): void {
  if (!request.operationId) throw new RangeError('operationId must be non-empty');
  if (!request.principal.id) throw new RangeError('principal.id must be non-empty');
  if (!request.tool) throw new RangeError('tool must be non-empty');
}

function newGrowthCursor(): string {
  return `g1.${randomUUID()}`;
}

function parseGrowthBalances(
  raw: string,
  budgetByHash: ReadonlyMap<string, Budget>,
): BudgetRemaining[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageStateError('Redis growth reply contained invalid budget balances');
  }
  if (!Array.isArray(parsed) || parsed.length !== budgetByHash.size) {
    throw new UsageStateError('Redis growth reply omitted a budget balance');
  }
  const balances: BudgetRemaining[] = parsed.map(entry => {
    if (!entry || typeof entry !== 'object') {
      throw new UsageStateError('Redis growth reply contained an invalid budget balance');
    }
    const value = entry as { hash?: unknown; remaining?: unknown };
    if (typeof value.hash !== 'string') {
      throw new UsageStateError('Redis growth reply contained an invalid budget hash');
    }
    const budget = budgetByHash.get(value.hash);
    if (!budget) throw new UsageStateError('Redis growth reply referenced an unknown budget');
    if (typeof value.remaining !== 'number' || !Number.isSafeInteger(value.remaining)) {
      throw new UsageStateError('Redis growth reply contained an invalid remaining balance');
    }
    return { key: budget.key, remaining: value.remaining };
  });
  balances.sort((a, b) => a.key.localeCompare(b.key));
  return balances;
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

function extractRecovery(reply: string[]): {
  payload: string[];
  recovery: RedisRecoverySummary;
} {
  const marker = reply.lastIndexOf('recovery');
  if (marker < 0) {
    return {
      payload: reply,
      recovery: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
    };
  }
  if (reply.length !== marker + 5) {
    throw new UsageStateError('Redis reserve reply contained an invalid recovery summary');
  }
  return {
    payload: reply.slice(0, marker),
    recovery: {
      pendingCount: parseInteger(reply[marker + 1], 'recovered pending count'),
      pendingUnits: parseInteger(reply[marker + 2], 'recovered pending units'),
      liableCount: parseInteger(reply[marker + 3], 'recovered liable count'),
      liableUnits: parseInteger(reply[marker + 4], 'recovered liable units'),
    },
  };
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
