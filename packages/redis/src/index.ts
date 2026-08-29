import { createHash, randomUUID } from 'node:crypto';
import {
  UsageStateError,
  assertUsageIdentifier,
  validateUsageBudgetEnvelope,
  validateUsageRequestEnvelope,
  validateUsageVectorEnvelope,
  validateUsageVectorGrowthEnvelope,
  emitUsageEvent,
  type Budget,
  type BudgetRemaining,
  type GrowReservationInput,
  type MarkLiableInput,
  type OperationReconciliationStore,
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
  type UsageOperationReconciliation,
  type UsageOperationReconciliationInput,
  type UsageStore,
  type UsageDimension,
  type UsageDimensionActual,
  type UsageDimensionGrowth,
  type UsageDimensionReserved,
  type VectorBudgetRemaining,
  type VectorGrowReservationInput,
  type VectorReservationDimension,
  type VectorSettleInput,
  type VectorSettlementResult,
  type VectorUsageStore,
  type VectorOperationReconciliationStore,
  type VectorUsageOperationReconciliation,
  type VectorUsageOperationReconciliationInput,
  type StoreVectorGrowResult,
  type StoreVectorReserveResult,
  type VectorReserveInput,
} from 'mcp-usage-control';
import {
  GROW_SCRIPT,
  GROW_VECTOR_SCRIPT,
  MARK_LIABLE_SCRIPT,
  RENEW_SCRIPT,
  RETIRE_HISTORICAL_BUDGETS_SCRIPT,
  RECONCILE_OPERATION_SCRIPT,
  RECONCILE_VECTOR_OPERATION_SCRIPT,
  RESERVE_SCRIPT,
  RESERVE_VECTOR_SCRIPT,
  SETTLE_SCRIPT,
  SETTLE_VECTOR_SCRIPT,
} from './scripts.js';

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
  vectorPendingCount: number;
  vectorLiableCount: number;
}

export interface RedisHistoricalBudgetRetirementInput {
  budgetKeys: readonly string[];
  /** Fail closed rather than atomically scanning more retained reservations than expected. */
  maxReservationsToInspect?: number;
}

export interface HistoricalBudgetRetirementResult {
  requested: number;
  retired: number;
  missing: number;
}

const RESERVATION_ID_PATTERN = /^r2\.([a-f0-9]{64})$/;

export class RedisUsageStore implements ProgressiveUsageStore, VectorOperationReconciliationStore, OperationReconciliationStore {
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

  async retireHistoricalBudgets(
    input: RedisHistoricalBudgetRetirementInput,
  ): Promise<HistoricalBudgetRetirementResult> {
    if (!Array.isArray(input.budgetKeys) || input.budgetKeys.length === 0) {
      throw new RangeError('budgetKeys must contain at least one exact historical key');
    }
    if (input.budgetKeys.length > 64) throw new RangeError('budgetKeys exceed the 64-key maintenance batch limit');
    const unique = [...new Set(input.budgetKeys)];
    if (unique.length !== input.budgetKeys.length) throw new RangeError('budgetKeys must not contain duplicates');
    for (const key of unique) assertUsageIdentifier(key, 'budgetKey');
    const maxReservationsToInspect = input.maxReservationsToInspect ?? 10_000;
    assertPositiveInteger(maxReservationsToInspect, 'maxReservationsToInspect');
    const keys = this.keys();
    const reply = parseReply(await this.client.eval(RETIRE_HISTORICAL_BUDGETS_SCRIPT, {
      keys: [keys.used, keys.reservations],
      arguments: [JSON.stringify(unique.map(digest)), String(maxReservationsToInspect)],
    }));
    if (reply[0] === 'active_reference') {
      throw new UsageStateError('Historical budget retirement blocked by an active reservation reference');
    }
    if (reply[0] === 'scan_limit') {
      throw new UsageStateError('Historical budget retirement inspection bound was exceeded');
    }
    if (reply[0] === 'unsupported_schema_version') {
      throw new UsageStateError('Historical budget retirement encountered unsupported retained state');
    }
    if (reply[0] !== 'ok') throw new UsageStateError('Redis historical budget retirement reply was invalid');
    return {
      requested: unique.length,
      retired: parseInteger(reply[1], 'retired budget count'),
      missing: parseInteger(reply[2], 'missing budget count'),
    };
  }

  async reconcileOperation(
    input: UsageOperationReconciliationInput,
  ): Promise<UsageOperationReconciliation> {
    assertNonNegativeInteger(input.units, 'units');
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
    const expectedBudgetHashes = budgets.map(budget => digest(budget.key));
    const keys = this.keys();
    const reply = parseReply(
      await this.client.eval(RECONCILE_OPERATION_SCRIPT, {
        keys: [keys.reservations, keys.tombstones],
        arguments: [reservationId],
      }),
    );

    if (reply[0] === 'absent') return { status: 'absent', reservationId };
    if (reply[0] === 'mode_mismatch') {
      throw new UsageStateError('Scalar operation reconciliation cannot target a vector reservation');
    }
    if (reply[0] === 'invalid_state') {
      throw new UsageStateError('Redis reservation had invalid reconciliation state');
    }

    if (reply[0] === 'active' || reply[0] === 'expired') {
      const state = reply[1];
      const reservedUnits = parseInteger(reply[2], 'reservedUnits');
      const expiresAt = parseInteger(reply[3], 'expiresAt');
      const hashes = parseStringArray(reply[4], 'budget hashes');
      const growthCursor = reply[5] ?? '';
      if (
        (state !== 'pending' && state !== 'liable') ||
        reservedUnits !== input.units ||
        !sameStringArray(hashes, expectedBudgetHashes)
      ) {
        throw new UsageStateError('Operation reconciliation input does not match retained reservation state');
      }
      if (reply[0] === 'expired') {
        return { status: 'expired', state, reservationId, expiredAt: expiresAt };
      }
      return {
        status: 'active',
        state,
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
          reservedUnits,
          expiresAt,
          ...(growthCursor.length === 0 ? {} : { growthCursor }),
        },
      };
    }

    if (reply[0] === 'settled') {
      const reservedUnits = parseInteger(reply[1], 'reservedUnits');
      const actualUnits = parseInteger(reply[2], 'actualUnits');
      const tombstoneExpiresAt = parseInteger(reply[3], 'tombstoneExpiresAt');
      const hashes = parseStringArray(reply[4], 'budget hashes');
      if (reservedUnits !== input.units || !sameStringArray(hashes, expectedBudgetHashes)) {
        throw new UsageStateError('Operation reconciliation input does not match retained reservation state');
      }
      return {
        status: 'settled',
        reservationId,
        reservedUnits,
        actualUnits,
        tombstoneExpiresAt,
      };
    }

    throw new UsageStateError('Redis reconciliation reply was invalid');
  }

  async reconcileVectorOperation(
    input: VectorUsageOperationReconciliationInput,
  ): Promise<VectorUsageOperationReconciliation> {
    validateRequestIdentity(input.request);
    const dimensions = canonicalizeUsageDimensions(input.dimensions);
    const operationKey = digest(JSON.stringify([
      input.request.principal.tenantId ?? null,
      input.request.principal.id,
      input.request.tool,
      input.request.operationId,
    ]));
    const reservationId = `r2.${operationKey}`;
    const maps = vectorMaps(dimensions);
    const reply = parseReply(await this.client.eval(RECONCILE_VECTOR_OPERATION_SCRIPT, {
      keys: [this.keys().reservations, this.keys().tombstones],
      arguments: [reservationId],
    }));
    if (reply[0] === 'absent') return { status: 'absent', reservationId };
    if (reply[0] === 'mode_mismatch') {
      throw new UsageStateError('Vector operation reconciliation cannot target a scalar reservation');
    }
    if (reply[0] === 'unsupported_schema_version') {
      throw new UsageStateError('Redis reservation schema version is not supported');
    }
    if (reply[0] === 'invalid_state') {
      throw new UsageStateError('Redis vector reservation had invalid reconciliation state');
    }
    if (reply[0] === 'active' || reply[0] === 'expired') {
      const state = reply[1];
      const expiresAt = parseInteger(reply[2], 'expiresAt');
      const stored = parseVectorReconciliationDimensions(reply[3], dimensions, maps);
      const growthCursor = reply[4] ?? '';
      if (state !== 'pending' && state !== 'liable') {
        throw new UsageStateError('Redis vector reconciliation state was invalid');
      }
      if (reply[0] === 'expired') {
        return { status: 'expired', state, reservationId, expiredAt: expiresAt };
      }
      return {
        status: 'active',
        state,
        reservation: {
          id: reservationId,
          operationId: input.request.operationId,
          principalId: input.request.principal.id,
          ...(input.request.principal.tenantId === undefined ? {} : { tenantId: input.request.principal.tenantId }),
          ...(input.request.principal.plan === undefined ? {} : { plan: input.request.principal.plan }),
          tool: input.request.tool,
          dimensions: stored,
          expiresAt,
          ...(growthCursor.length === 0 ? {} : { growthCursor }),
        },
      };
    }
    if (reply[0] === 'settled') {
      const tombstoneExpiresAt = parseInteger(reply[1], 'tombstoneExpiresAt');
      const stored = parseVectorReconciliationDimensions(reply[2], dimensions, maps);
      const actualByDimension = parseVectorReconciliationActuals(reply[3], maps.dimensionByHash);
      return {
        status: 'settled',
        reservationId,
        reservedByDimension: stored.map(dimension => ({ key: dimension.key, reservedUnits: dimension.reservedUnits })),
        actualByDimension,
        tombstoneExpiresAt,
      };
    }
    throw new UsageStateError('Redis vector reconciliation reply was invalid');
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
    assertRedisTimeReply(parsed);
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

  async reserveVector(input: VectorReserveInput): Promise<StoreVectorReserveResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    validateRequestIdentity(input.request);
    const dimensions = canonicalizeUsageDimensions(input.dimensions);
    const operationKey = digest(
      JSON.stringify([
        input.request.principal.tenantId ?? null,
        input.request.principal.id,
        input.request.tool,
        input.request.operationId,
      ]),
    );
    const reservationId = `r2.${operationKey}`;
    const maps = vectorMaps(dimensions);
    const encoded = dimensions.map(dimension => ({
      hash: digest(dimension.key),
      units: dimension.units,
      budgets: dimension.budgets.map(budget => ({ hash: digest(budget.key), limit: budget.limit })),
    }));
    const initialGrowthCursor = newGrowthCursor();
    const keys = this.keys();
    const parsed = parseReply(
      await this.client.eval(RESERVE_VECTOR_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          String(input.ttlMs),
          reservationId,
          operationKey,
          String(this.cleanupBatchSize),
          String(this.idempotencyTtlMs),
          JSON.stringify(encoded),
          initialGrowthCursor,
        ],
      }),
    );
    assertRedisTimeReply(parsed);
    const { payload: reply, recovery } = extractRecovery(parsed);
    this.emitRecoverySummary(recovery);
    if (reply[0] === 'accepted') {
      const expiresAt = parseInteger(reply[1], 'expiresAt');
      const balances = parseVectorBalances(reply[2], maps);
      return {
        accepted: true,
        reservation: {
          id: reservationId,
          operationId: input.request.operationId,
          principalId: input.request.principal.id,
          ...(input.request.principal.tenantId === undefined
            ? {}
            : { tenantId: input.request.principal.tenantId }),
          ...(input.request.principal.plan === undefined ? {} : { plan: input.request.principal.plan }),
          tool: input.request.tool,
          dimensions: dimensions.map(dimension => ({
            key: dimension.key,
            budgetKeys: dimension.budgets.map(budget => budget.key),
            reservedUnits: dimension.units,
          })),
          expiresAt,
          growthCursor: initialGrowthCursor,
        },
        remainingByBudget: balances,
      };
    }
    if (reply[0] === 'quota_exceeded') {
      const dimension = reply[1] ? maps.dimensionByHash.get(reply[1]) : undefined;
      const budget = reply[2] ? maps.budgetByHash.get(reply[2]) : undefined;
      if (!dimension || !budget || reply[3] === undefined) {
        throw new UsageStateError('Redis vector quota reply was incomplete');
      }
      return {
        accepted: false,
        reason: 'quota_exceeded',
        limitingDimensionKey: dimension.key,
        limitingBudgetKey: budget.key,
        remaining: parseInteger(reply[3], 'remaining'),
      };
    }
    if (reply[0] === 'duplicate_operation') {
      return { accepted: false, reason: 'duplicate_operation' };
    }
    throw new UsageStateError(`Unexpected Redis vector reserve reply: ${reply[0] ?? '<empty>'}`);
  }

  async growVectorReservation(input: VectorGrowReservationInput): Promise<StoreVectorGrowResult> {
    assertReservationId(input.reservationId);
    if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
      throw new RangeError('incrementId must be a non-empty string');
    }
    if (typeof input.expectedGrowthCursor !== 'string' || input.expectedGrowthCursor.length === 0) {
      throw new RangeError('expectedGrowthCursor must be a non-empty string');
    }
    const dimensions = canonicalizeGrowthDimensions(input.dimensions);
    const maps = vectorGrowthMaps(dimensions);
    const encoded = dimensions.map(dimension => ({
      hash: digest(dimension.key),
      additionalUnits: dimension.additionalUnits,
      budgets: dimension.budgets.map(budget => ({ hash: digest(budget.key), limit: budget.limit })),
    }));
    const incrementHash = digest(input.incrementId);
    const fingerprint = digest(JSON.stringify(encoded));
    const nextGrowthCursor = newGrowthCursor();
    const keys = this.keys();
    const reply = parseReply(
      await this.client.eval(GROW_VECTOR_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          input.reservationId,
          incrementHash,
          input.expectedGrowthCursor,
          String(this.idempotencyTtlMs),
          JSON.stringify(encoded),
          fingerprint,
          nextGrowthCursor,
        ],
      }),
    );
    assertRedisTimeReply(reply);
    if (reply[0] === 'accepted' || reply[0] === 'accepted_replay') {
      const cursor = reply[1];
      if (!cursor) throw new UsageStateError('Redis vector growth reply omitted growth cursor');
      return {
        accepted: true,
        replayed: reply[0] === 'accepted_replay',
        reservationId: input.reservationId,
        incrementId: input.incrementId,
        growthCursor: cursor,
        previousReservedByDimension: parseVectorReserved(reply[2], maps.dimensionByHash),
        reservedByDimension: parseVectorReserved(reply[3], maps.dimensionByHash),
        remainingByBudget: parseVectorBalances(reply[4], maps),
      };
    }
    if (reply[0] === 'quota_exceeded' || reply[0] === 'quota_replay') {
      const cursor = reply[1];
      const dimension = reply[2] ? maps.dimensionByHash.get(reply[2]) : undefined;
      const budget = reply[3] ? maps.budgetByHash.get(reply[3]) : undefined;
      if (!cursor || !dimension || !budget || reply[4] === undefined) {
        throw new UsageStateError('Redis vector growth quota reply was incomplete');
      }
      return {
        accepted: false,
        reason: 'quota_exceeded',
        replayed: reply[0] === 'quota_replay',
        reservationId: input.reservationId,
        incrementId: input.incrementId,
        growthCursor: cursor,
        limitingDimensionKey: dimension.key,
        limitingBudgetKey: budget.key,
        remaining: parseInteger(reply[4], 'remaining'),
      };
    }
    if (reply[0] === 'expired_vector') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    if (reply[0] === 'conflict') {
      throw new UsageStateError('Vector growth increment was already attempted with different parameters');
    }
    if (reply[0] === 'stale_cursor') {
      throw new UsageStateError('Vector growth cursor is stale or conflicts with reservation state');
    }
    if (reply[0] === 'dimension_mismatch') {
      throw new UsageStateError('Vector growth dimensions and budgets must match the reservation');
    }
    if (reply[0] === 'not_supported') {
      throw new UsageStateError('Vector reservation does not support progressive growth');
    }
    if (reply[0] === 'mode_mismatch') {
      throw new UsageStateError('Vector growth cannot target a scalar reservation');
    }
    if (reply[0] === 'terminal' || reply[0] === 'not_found') {
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    throw new UsageStateError(`Unexpected Redis vector growth reply: ${reply[0] ?? '<empty>'}`);
  }

  async settleVector(input: VectorSettleInput): Promise<VectorSettlementResult> {
    assertReservationId(input.reservationId);
    const actuals = canonicalizeActualDimensions(input.actualByDimension);
    const dimensionByHash = new Map<string, { key: string }>();
    const encoded = actuals.map(actual => {
      const hash = digest(actual.key);
      dimensionByHash.set(hash, { key: actual.key });
      return { hash, actualUnits: actual.actualUnits };
    });
    const keys = this.keys();
    const reply = parseReply(
      await this.client.eval(SETTLE_VECTOR_SCRIPT, {
        keys: [keys.used, keys.leases, keys.reservations, keys.operations, keys.tombstones],
        arguments: [
          input.reservationId,
          JSON.stringify(encoded),
          input.outcome,
          String(this.idempotencyTtlMs),
        ],
      }),
    );
    assertRedisTimeReply(reply);
    if (reply[0] === 'settled' || reply[0] === 'idempotent') {
      return {
        reservationId: input.reservationId,
        dimensions: parseVectorSettlement(reply[1], dimensionByHash),
        outcome: input.outcome,
      };
    }
    if (reply[0] === 'conflict') {
      throw new UsageStateError('Vector reservation was already settled with a different result');
    }
    if (reply[0] === 'invalid_units') {
      throw new UsageStateError('actualUnits cannot exceed reservedUnits for a vector dimension');
    }
    if (reply[0] === 'dimension_mismatch') {
      throw new UsageStateError('Vector settlement dimensions must exactly match the reservation');
    }
    if (reply[0] === 'mode_mismatch') {
      throw new UsageStateError('Vector settlement cannot target a scalar reservation');
    }
    if (reply[0] === 'expired_vector') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    if (reply[0] === 'not_found' || reply[0] === 'not_pending') {
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    throw new UsageStateError(`Unexpected Redis vector settle reply: ${reply[0] ?? '<empty>'}`);
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
    assertRedisTimeReply(reply);

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

    if (reply[0] === 'expired' || reply[0] === 'expired_vector') {
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
    if (reply[0] === 'mode_mismatch') {
      throw new UsageStateError('Scalar growth cannot target a vector reservation');
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
    assertRedisTimeReply(reply);

    if (reply[0] === 'marked') {
      return {
        reservationId: input.reservationId,
        expiresAt: parseInteger(reply[1], 'expiresAt'),
      };
    }
    if (reply[0] === 'expired' || reply[0] === 'expired_vector') {
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
    assertRedisTimeReply(reply);

    if (reply[0] === 'renewed') {
      return {
        reservationId: input.reservationId,
        expiresAt: parseInteger(reply[1], 'expiresAt'),
      };
    }

    if (reply[0] === 'expired' || reply[0] === 'expired_vector') {
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
    assertRedisTimeReply(reply);

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
    if (reply[0] === 'expired' || reply[0] === 'expired_vector') {
      this.emitDirectExpiry(reply, input.reservationId);
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    if (reply[0] === 'mode_mismatch') {
      throw new UsageStateError('Scalar settlement cannot target a vector reservation');
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
    if (recovery.vectorPendingCount > 0) {
      emitUsageEvent(this.observer, {
        type: 'vector.reservation.recovered',
        timestamp: Date.now(),
        store: 'redis',
        recovery: 'pending_released',
        count: recovery.vectorPendingCount,
      });
    }
    if (recovery.vectorLiableCount > 0) {
      emitUsageEvent(this.observer, {
        type: 'vector.reservation.recovered',
        timestamp: Date.now(),
        store: 'redis',
        recovery: 'liable_retained',
        count: recovery.vectorLiableCount,
      });
    }
  }

  private emitDirectExpiry(reply: string[], reservationId: string): void {
    const state = reply[1];
    if (state !== 'pending' && state !== 'liable') return;
    if (reply[0] === 'expired_vector') {
      emitUsageEvent(this.observer, {
        type: 'vector.reservation.recovered',
        timestamp: Date.now(),
        store: 'redis',
        recovery: state === 'pending' ? 'pending_released' : 'liable_retained',
        reservationId,
        dimensionCount: parseInteger(reply[2], 'expired dimension count'),
        budgetCount: parseInteger(reply[3], 'expired budget count'),
        count: 1,
      });
      return;
    }
    const reservedUnits = parseInteger(reply[2], 'expired reservedUnits');
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

function canonicalizeUsageDimensions(dimensions: readonly UsageDimension[]): UsageDimension[] {
  if (dimensions.length === 0) throw new RangeError('dimensions must contain at least one dimension');
  const normalized = dimensions.map(dimension => {
    if (typeof dimension.key !== 'string' || dimension.key.length === 0) {
      throw new RangeError('dimension.key must be a non-empty string');
    }
    assertNonNegativeInteger(dimension.units, `dimension.units (${dimension.key})`);
    return { key: dimension.key, units: dimension.units, budgets: canonicalizeBudgets(dimension.budgets) };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  validateVectorTopology(normalized);
  return normalized;
}

function canonicalizeGrowthDimensions(
  dimensions: readonly UsageDimensionGrowth[],
): UsageDimensionGrowth[] {
  if (dimensions.length === 0) throw new RangeError('dimensions must contain at least one dimension');
  const normalized = dimensions.map(dimension => {
    if (typeof dimension.key !== 'string' || dimension.key.length === 0) {
      throw new RangeError('dimension.key must be a non-empty string');
    }
    assertNonNegativeInteger(
      dimension.additionalUnits,
      `dimension.additionalUnits (${dimension.key})`,
    );
    return {
      key: dimension.key,
      additionalUnits: dimension.additionalUnits,
      budgets: canonicalizeBudgets(dimension.budgets),
    };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  validateVectorTopology(normalized);
  if (!normalized.some(dimension => dimension.additionalUnits > 0)) {
    throw new RangeError('vector growth must add units to at least one dimension');
  }
  return normalized;
}

function canonicalizeActualDimensions(
  actuals: readonly UsageDimensionActual[],
): UsageDimensionActual[] {
  if (actuals.length === 0) throw new RangeError('actualByDimension must contain at least one dimension');
  const normalized = actuals.map(actual => {
    if (typeof actual.key !== 'string' || actual.key.length === 0) {
      throw new RangeError('actual dimension key must be a non-empty string');
    }
    assertNonNegativeInteger(actual.actualUnits, `actualUnits (${actual.key})`);
    return { key: actual.key, actualUnits: actual.actualUnits };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.key === normalized[index]!.key) {
      throw new RangeError(`duplicate dimension key: ${normalized[index]!.key}`);
    }
  }
  return normalized;
}

function validateVectorTopology(
  dimensions: readonly { key: string; budgets: readonly Budget[] }[],
): void {
  const dimensionKeys = new Set<string>();
  const budgetKeys = new Set<string>();
  for (const dimension of dimensions) {
    if (dimensionKeys.has(dimension.key)) throw new RangeError(`duplicate dimension key: ${dimension.key}`);
    dimensionKeys.add(dimension.key);
    for (const budget of dimension.budgets) {
      if (budgetKeys.has(budget.key)) {
        throw new RangeError(`budget key cannot appear in multiple vector dimensions: ${budget.key}`);
      }
      budgetKeys.add(budget.key);
    }
  }
}

type VectorMaps = {
  dimensionByHash: Map<string, { key: string }>;
  budgetByHash: Map<string, { key: string }>;
  budgetCount: number;
};

function vectorMaps(dimensions: readonly UsageDimension[]): VectorMaps {
  const dimensionByHash = new Map<string, { key: string }>();
  const budgetByHash = new Map<string, { key: string }>();
  let budgetCount = 0;
  for (const dimension of dimensions) {
    dimensionByHash.set(digest(dimension.key), { key: dimension.key });
    for (const budget of dimension.budgets) {
      budgetByHash.set(digest(budget.key), { key: budget.key });
      budgetCount += 1;
    }
  }
  return { dimensionByHash, budgetByHash, budgetCount };
}

function vectorGrowthMaps(dimensions: readonly UsageDimensionGrowth[]): VectorMaps {
  const dimensionByHash = new Map<string, { key: string }>();
  const budgetByHash = new Map<string, { key: string }>();
  let budgetCount = 0;
  for (const dimension of dimensions) {
    dimensionByHash.set(digest(dimension.key), { key: dimension.key });
    for (const budget of dimension.budgets) {
      budgetByHash.set(digest(budget.key), { key: budget.key });
      budgetCount += 1;
    }
  }
  return { dimensionByHash, budgetByHash, budgetCount };
}

function parseJsonArray(raw: string | undefined, context: string): unknown[] {
  if (raw === undefined) throw new UsageStateError(`${context} was missing`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UsageStateError(`${context} contained invalid JSON`);
  }
  if (!Array.isArray(value)) throw new UsageStateError(`${context} must be an array`);
  return value;
}

function parseVectorReconciliationDimensions(
  raw: string | undefined,
  expected: readonly UsageDimension[],
  maps: VectorMaps,
): VectorReservationDimension[] {
  const entries = parseJsonArray(raw, 'Redis vector reconciliation dimensions');
  if (entries.length !== expected.length) {
    throw new UsageStateError('Vector reconciliation input does not match retained reservation state');
  }
  const expectedByHash = new Map(expected.map(dimension => [digest(dimension.key), dimension] as const));
  const result = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new UsageStateError('Redis vector reconciliation dimension was invalid');
    const value = entry as { hash?: unknown; budgetHashes?: unknown; reservedUnits?: unknown };
    const candidate = typeof value.hash === 'string' ? expectedByHash.get(value.hash) : undefined;
    if (!candidate || !Array.isArray(value.budgetHashes) || typeof value.reservedUnits !== 'number' || !Number.isSafeInteger(value.reservedUnits)) {
      throw new UsageStateError('Vector reconciliation input does not match retained reservation state');
    }
    const expectedHashes = candidate.budgets.map(budget => digest(budget.key));
    if (value.reservedUnits !== candidate.units || !sameStringArray(value.budgetHashes as string[], expectedHashes)) {
      throw new UsageStateError('Vector reconciliation input does not match retained reservation state');
    }
    return { key: candidate.key, budgetKeys: candidate.budgets.map(budget => budget.key), reservedUnits: value.reservedUnits };
  });
  result.sort((a, b) => a.key.localeCompare(b.key));
  if (result.length !== maps.dimensionByHash.size) throw new UsageStateError('Redis vector reconciliation topology was incomplete');
  return result;
}

function parseVectorReconciliationActuals(
  raw: string | undefined,
  dimensionByHash: ReadonlyMap<string, { key: string }>,
): UsageDimensionActual[] {
  const entries = parseJsonArray(raw, 'Redis vector reconciliation actuals');
  if (entries.length !== dimensionByHash.size) throw new UsageStateError('Redis vector reconciliation actuals were incomplete');
  const result = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new UsageStateError('Redis vector reconciliation actual was invalid');
    const value = entry as { hash?: unknown; actualUnits?: unknown };
    const dimension = typeof value.hash === 'string' ? dimensionByHash.get(value.hash) : undefined;
    if (!dimension || typeof value.actualUnits !== 'number' || !Number.isSafeInteger(value.actualUnits) || value.actualUnits < 0) {
      throw new UsageStateError('Redis vector reconciliation actual referenced an unknown dimension');
    }
    return { key: dimension.key, actualUnits: value.actualUnits };
  });
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

function parseVectorBalances(raw: string | undefined, maps: VectorMaps): VectorBudgetRemaining[] {
  const entries = parseJsonArray(raw, 'Redis vector balance reply');
  if (entries.length !== maps.budgetCount) {
    throw new UsageStateError('Redis vector balance reply omitted a budget');
  }
  const result = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new UsageStateError('Redis vector balance entry was invalid');
    const value = entry as { dimensionHash?: unknown; budgetHash?: unknown; remaining?: unknown };
    const dimension = typeof value.dimensionHash === 'string' ? maps.dimensionByHash.get(value.dimensionHash) : undefined;
    const budget = typeof value.budgetHash === 'string' ? maps.budgetByHash.get(value.budgetHash) : undefined;
    if (!dimension || !budget || typeof value.remaining !== 'number' || !Number.isSafeInteger(value.remaining)) {
      throw new UsageStateError('Redis vector balance reply referenced an unknown dimension or budget');
    }
    return { dimensionKey: dimension.key, budgetKey: budget.key, remaining: value.remaining };
  });
  result.sort((a, b) => a.dimensionKey.localeCompare(b.dimensionKey) || a.budgetKey.localeCompare(b.budgetKey));
  return result;
}

function parseVectorReserved(
  raw: string | undefined,
  dimensionByHash: ReadonlyMap<string, { key: string }>,
): UsageDimensionReserved[] {
  const entries = parseJsonArray(raw, 'Redis vector reserved reply');
  if (entries.length !== dimensionByHash.size) {
    throw new UsageStateError('Redis vector reserved reply omitted a dimension');
  }
  const result = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new UsageStateError('Redis vector reserved entry was invalid');
    const value = entry as { hash?: unknown; reservedUnits?: unknown };
    const dimension = typeof value.hash === 'string' ? dimensionByHash.get(value.hash) : undefined;
    if (!dimension || typeof value.reservedUnits !== 'number' || !Number.isSafeInteger(value.reservedUnits)) {
      throw new UsageStateError('Redis vector reserved reply referenced an unknown dimension');
    }
    return { key: dimension.key, reservedUnits: value.reservedUnits };
  });
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

function parseVectorSettlement(
  raw: string | undefined,
  dimensionByHash: ReadonlyMap<string, { key: string }>,
): VectorSettlementResult['dimensions'] {
  const entries = parseJsonArray(raw, 'Redis vector settlement reply');
  if (entries.length !== dimensionByHash.size) {
    throw new UsageStateError('Redis vector settlement reply omitted a dimension');
  }
  const result = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new UsageStateError('Redis vector settlement entry was invalid');
    const value = entry as {
      hash?: unknown;
      reservedUnits?: unknown;
      actualUnits?: unknown;
      releasedUnits?: unknown;
    };
    const dimension = typeof value.hash === 'string' ? dimensionByHash.get(value.hash) : undefined;
    if (
      !dimension ||
      typeof value.reservedUnits !== 'number' || !Number.isSafeInteger(value.reservedUnits) ||
      typeof value.actualUnits !== 'number' || !Number.isSafeInteger(value.actualUnits) ||
      typeof value.releasedUnits !== 'number' || !Number.isSafeInteger(value.releasedUnits)
    ) {
      throw new UsageStateError('Redis vector settlement reply referenced an unknown dimension');
    }
    return {
      key: dimension.key,
      reservedUnits: value.reservedUnits,
      actualUnits: value.actualUnits,
      releasedUnits: value.releasedUnits,
    };
  });
  result.sort((a, b) => a.key.localeCompare(b.key));
  return result;
}

function validateRequestIdentity(request: UsageRequest): void {
  validateUsageRequestEnvelope(request);
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

function parseStringArray(value: string | undefined, name: string): string[] {
  if (value === undefined) throw new UsageStateError(`Redis reply omitted ${name}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageStateError(`Redis reply had invalid ${name}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new UsageStateError(`Redis reply had invalid ${name}`);
  }
  return parsed;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRedisTimeReply(reply: readonly string[]): void {
  if (reply[0] === 'invalid_time') {
    throw new RangeError('Redis timestamp arithmetic exceeds safe integer range');
  }
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
      recovery: {
        pendingCount: 0,
        pendingUnits: 0,
        liableCount: 0,
        liableUnits: 0,
        vectorPendingCount: 0,
        vectorLiableCount: 0,
      },
    };
  }
  if (reply.length !== marker + 7) {
    throw new UsageStateError('Redis reserve reply contained an invalid recovery summary');
  }
  return {
    payload: reply.slice(0, marker),
    recovery: {
      pendingCount: parseInteger(reply[marker + 1], 'recovered pending count'),
      pendingUnits: parseInteger(reply[marker + 2], 'recovered pending units'),
      liableCount: parseInteger(reply[marker + 3], 'recovered liable count'),
      liableUnits: parseInteger(reply[marker + 4], 'recovered liable units'),
      vectorPendingCount: parseInteger(reply[marker + 5], 'recovered vector pending count'),
      vectorLiableCount: parseInteger(reply[marker + 6], 'recovered vector liable count'),
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
