import { createHash, randomUUID } from 'node:crypto';
import {
  UsageStateError,
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
  type UsageRequest,
  type UsageStore,
  type UsageDimension,
  type UsageDimensionActual,
  type UsageDimensionGrowth,
  type UsageDimensionReserved,
  type VectorBudgetRemaining,
  type VectorGrowReservationInput,
  type VectorReserveInput,
  type VectorSettleInput,
  type VectorSettlementResult,
  type VectorUsageStore,
  type StoreVectorGrowResult,
  type StoreVectorReserveResult,
} from 'mcp-usage-control';

/**
 * Minimal structural Firestore types used by this adapter.
 *
 * Firebase Admin `getFirestore()` and the Google Cloud Node.js Firestore client
 * satisfy this shape without making either SDK a runtime dependency of this package.
 */
export interface FirestoreDocumentReferenceLike {
  readonly id: string;
}

export interface FirestoreDocumentSnapshotLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreQueryDocumentSnapshotLike extends FirestoreDocumentSnapshotLike {
  readonly ref: FirestoreDocumentReferenceLike;
}

export interface FirestoreQuerySnapshotLike {
  readonly docs: readonly FirestoreQueryDocumentSnapshotLike[];
}

export interface FirestoreQueryLike {
  where(fieldPath: string, opStr: string, value: unknown): FirestoreQueryLike;
  limit(limit: number): FirestoreQueryLike;
  get(): Promise<FirestoreQuerySnapshotLike>;
}

export interface FirestoreCollectionReferenceLike extends FirestoreQueryLike {
  doc(documentPath: string): FirestoreDocumentReferenceLike;
}

export interface FirestoreTransactionLike {
  get(reference: FirestoreDocumentReferenceLike): Promise<FirestoreDocumentSnapshotLike>;
  getAll(
    ...references: readonly FirestoreDocumentReferenceLike[]
  ): Promise<FirestoreDocumentSnapshotLike[]>;
  set(
    reference: FirestoreDocumentReferenceLike,
    data: Record<string, unknown>,
  ): FirestoreTransactionLike;
  delete(reference: FirestoreDocumentReferenceLike): FirestoreTransactionLike;
}

/**
 * Public structural boundary for an official server-side Firestore client.
 *
 * The callback parameter is deliberately broad because TypeScript cannot
 * structurally assign the SDK's overloaded Transaction methods to the smaller
 * adapter transaction interface through the higher-order runTransaction()
 * signature. Adapter internals narrow the callback back to
 * FirestoreTransactionLike via the private runTransaction() helper.
 */
export interface FirestoreLike {
  collection(collectionPath: string): unknown;
  runTransaction<T>(
    updateFunction: (transaction: any) => Promise<T>,
  ): Promise<T>;
}

export type FirestoreRecoveryEvent =
  | {
      type: 'reservation.recovered';
      timestamp: number;
      store: 'firestore';
      recovery: 'pending_released' | 'liable_retained';
      reservationId: string;
      reservedUnits: number;
      count: 1;
    }
  | {
      type: 'vector.reservation.recovered';
      timestamp: number;
      store: 'firestore';
      recovery: 'pending_released' | 'liable_retained';
      reservationId: string;
      dimensionCount: number;
      budgetCount: number;
      count: 1;
    };

export interface FirestoreRecoveryObserver {
  onEvent(event: FirestoreRecoveryEvent): void | Promise<void>;
}

export interface FirestoreUsageStoreOptions {
  /** Prefix for the two top-level collections. Defaults to `muc`. */
  collectionPrefix?: string;
  /** How long a settled operation remains replay-protected. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /** Maximum expired reservation/tombstone rows reclaimed by one cleanup pass. Defaults to 16. */
  cleanupBatchSize?: number;
  /** Per-process minimum interval between automatic cleanup queries. Defaults to 5 seconds. */
  cleanupIntervalMs?: number;
  /**
   * Extra delay before a lease/tombstone is considered expired. Defaults to 5 seconds.
   * Firestore does not expose transaction commit time to this structural adapter, so
   * lease arithmetic uses the application host clock. Keep hosts time-synchronized.
   */
  expiryGraceMs?: number;
  /** Optional best-effort observer for expiry/recovery events. */
  observer?: FirestoreRecoveryObserver;
  /** Test hook. Production callers should normally keep the Date.now default. */
  now?: () => number;
}

export interface FirestoreRecoverySummary {
  pendingCount: number;
  pendingUnits: number;
  liableCount: number;
  liableUnits: number;
  vectorPendingCount: number;
  vectorLiableCount: number;
  tombstonesDeleted: number;
}

type ReservationState = 'pending' | 'liable' | 'settled';

interface StoredGrowthReplay {
  incrementHash: string;
  expectedGrowthCursor: string;
  fingerprint: string;
  nextGrowthCursor: string;
  accepted: boolean;
  previousReservedUnits?: number;
  reservedUnits?: number;
  remainingByBudgetIds?: Array<{ budgetId: string; remaining: number }>;
  limitingBudgetId?: string;
  remaining?: number;
}

interface StoredVectorDimension {
  dimensionHash: string;
  budgetIds: string[];
  reservedUnits: number;
}

interface StoredVectorGrowthReplay {
  incrementHash: string;
  expectedGrowthCursor: string;
  fingerprint: string;
  nextGrowthCursor: string;
  accepted: boolean;
  previousReservedByDimensions?: Array<{ dimensionHash: string; reservedUnits: number }>;
  reservedByDimensions?: Array<{ dimensionHash: string; reservedUnits: number }>;
  remainingByBudgetIds?: Array<{
    dimensionHash: string;
    budgetId: string;
    remaining: number;
  }>;
  limitingDimensionHash?: string;
  limitingBudgetId?: string;
  remaining?: number;
}

interface StoredReservation {
  schemaVersion: 1;
  state: ReservationState;
  budgetIds: string[];
  reservedUnits: number;
  expiresAtMs: number;
  actualUnits?: number;
  outcomeHash?: string;
  growthCursor?: string;
  lastGrowth?: StoredGrowthReplay;
  mode?: 'vector';
  dimensions?: StoredVectorDimension[];
  actualByDimensions?: Array<{ dimensionHash: string; actualUnits: number }>;
  lastVectorGrowth?: StoredVectorGrowthReplay;
}

interface RecoveryResult {
  kind: 'none' | 'pending_released' | 'liable_retained' | 'tombstone_deleted';
  reservedUnits: number;
  vector?: { dimensionCount: number; budgetCount: number };
}

interface ReserveTransactionResult {
  result: StoreReserveResult;
  recovery?: RecoveryResult;
}

interface ActiveTransactionResult<T> {
  ok: true;
  value: T;
}

interface FailedActiveTransactionResult {
  ok: false;
  recovery?: RecoveryResult;
}

const RESERVATION_ID_PATTERN = /^fs1\.[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EXPIRED_LIABLE_OUTCOME = 'lease_expired_after_execution_started';

/**
 * Firestore-backed `UsageStore` for server-side Node.js runtimes.
 *
 * Atomicity is provided by Firestore transactions across the reservation document
 * and every participating budget document. Budget keys and operation identity tuples
 * are SHA-256 hashed before becoming document IDs; hashing reduces accidental identifier
 * exposure but is not encryption.
 */
export class FirestoreUsageStore implements ProgressiveUsageStore, VectorUsageStore {
  private readonly prefix: string;
  private readonly idempotencyTtlMs: number;
  private readonly cleanupBatchSize: number;
  private readonly cleanupIntervalMs: number;
  private readonly expiryGraceMs: number;
  private readonly observer: FirestoreRecoveryObserver | undefined;
  private readonly now: () => number;
  private lastCleanupStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly firestore: FirestoreLike,
    options: FirestoreUsageStoreOptions = {},
  ) {
    this.prefix = options.collectionPrefix ?? 'muc';
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
    this.cleanupBatchSize = options.cleanupBatchSize ?? 16;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 5_000;
    this.expiryGraceMs = options.expiryGraceMs ?? 5_000;
    this.observer = options.observer;
    this.now = options.now ?? Date.now;

    if (this.prefix.length === 0 || this.prefix.includes('/')) {
      throw new RangeError('collectionPrefix must be non-empty and must not contain /');
    }
    assertPositiveInteger(this.idempotencyTtlMs, 'idempotencyTtlMs');
    assertNonNegativeInteger(this.cleanupBatchSize, 'cleanupBatchSize');
    assertNonNegativeInteger(this.cleanupIntervalMs, 'cleanupIntervalMs');
    assertNonNegativeInteger(this.expiryGraceMs, 'expiryGraceMs');
  }

  async reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    assertNonNegativeInteger(input.units, 'units');
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    validateRequestIdentity(input.request);
    const budgets = canonicalizeBudgets(input.budgets);

    const now = this.nowMs();
    await this.maybeCleanup(now);

    const reservationId = reservationIdFor(input.request);
    const reservationRef = this.reservations().doc(reservationId);
    const currentBudgetIds = budgets.map(budget => digest(budget.key));
    const initialGrowthCursor = newGrowthCursor();

    const transactionResult = await this.runTransaction<ReserveTransactionResult>(
      async transaction => {
        const existingSnapshot = await transaction.get(reservationRef);
        const existing = readReservation(existingSnapshot);
        const existingBudgetIds = existing ? reservationBudgetIds(existing) : [];
        const allBudgetIds = uniqueSorted([...currentBudgetIds, ...existingBudgetIds]);
        const usedById = await readBudgets(transaction, this.budgets(), allBudgetIds);

        let recovery: RecoveryResult | undefined;
        if (existing) {
          if (!this.isExpired(existing, now)) {
            return { result: { accepted: false, reason: 'duplicate_operation' } };
          }

          recovery = recoverStoredReservation(existing, usedById);
          if (recovery.kind === 'liable_retained') {
            transaction.set(
              reservationRef,
              settledFromExpiredLiable(existing, now, this.idempotencyTtlMs),
            );
            return {
              result: { accepted: false, reason: 'duplicate_operation' },
              recovery,
            };
          }
        }

        const remainingByBudget: BudgetRemaining[] = budgets.map((budget, index) => ({
          key: budget.key,
          remaining: Math.max(
            0,
            budget.limit - (usedById.get(currentBudgetIds[index]!) ?? 0),
          ),
        }));
        const limiting = remainingByBudget.find(balance => input.units > balance.remaining);

        if (limiting) {
          if (recovery?.kind === 'pending_released') {
            writeUsedBudgets(
              transaction,
              this.budgets(),
              usedById,
              existingBudgetIds,
              now,
            );
            transaction.delete(reservationRef);
          } else if (recovery?.kind === 'tombstone_deleted') {
            transaction.delete(reservationRef);
          }

          return {
            result: {
              accepted: false,
              reason: 'quota_exceeded',
              limitingBudgetKey: limiting.key,
              remaining: limiting.remaining,
            },
            ...(recovery === undefined ? {} : { recovery }),
          };
        }

        for (const budgetId of currentBudgetIds) {
          const next = safeAdd(usedById.get(budgetId) ?? 0, input.units, 'budget usage');
          usedById.set(budgetId, next);
        }

        const expiresAt = safeAdd(now, input.ttlMs, 'reservation expiry');
        const stored: StoredReservation = {
          schemaVersion: 1,
          state: 'pending',
          budgetIds: currentBudgetIds,
          reservedUnits: input.units,
          expiresAtMs: expiresAt,
          growthCursor: initialGrowthCursor,
        };

        const touchedBudgetIds = uniqueSorted([
          ...currentBudgetIds,
          ...(recovery?.kind === 'pending_released' ? existingBudgetIds : []),
        ]);
        writeUsedBudgets(transaction, this.budgets(), usedById, touchedBudgetIds, now);
        // An expired settled tombstone can be overwritten directly. Avoid a
        // delete+set pair against the same document in one transaction.
        transaction.set(reservationRef, stored as unknown as Record<string, unknown>);

        return {
          result: {
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
            remainingByBudget: remainingByBudget.map(balance => ({
              key: balance.key,
              remaining: balance.remaining - input.units,
            })),
          },
          ...(recovery === undefined ? {} : { recovery }),
        };
      },
    );

    if (transactionResult.recovery) {
      this.emitRecovery(transactionResult.recovery, reservationId, now);
    }
    return transactionResult.result;
  }

  async reserveVector(input: VectorReserveInput): Promise<StoreVectorReserveResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    validateRequestIdentity(input.request);
    const dimensions = canonicalizeUsageDimensions(input.dimensions);
    const entries = dimensions.map(dimension => ({
      dimension,
      dimensionHash: digest(dimension.key),
      budgets: dimension.budgets.map(budget => ({ budget, budgetId: digest(budget.key) })),
    }));
    const currentBudgetIds = entries.flatMap(entry => entry.budgets.map(budget => budget.budgetId));
    const now = this.nowMs();
    await this.maybeCleanup(now);
    const reservationId = reservationIdFor(input.request);
    const reservationRef = this.reservations().doc(reservationId);
    const initialGrowthCursor = newGrowthCursor();

    const transactionResult = await this.runTransaction<{
      result: StoreVectorReserveResult;
      recovery?: RecoveryResult;
    }>(async transaction => {
      const existingSnapshot = await transaction.get(reservationRef);
      const existing = readReservation(existingSnapshot);
      const existingBudgetIds = existing ? reservationBudgetIds(existing) : [];
      const allBudgetIds = uniqueSorted([...currentBudgetIds, ...existingBudgetIds]);
      const usedById = await readBudgets(transaction, this.budgets(), allBudgetIds);

      let recovery: RecoveryResult | undefined;
      if (existing) {
        if (!this.isExpired(existing, now)) {
          return { result: { accepted: false, reason: 'duplicate_operation' } };
        }
        recovery = recoverStoredReservation(existing, usedById);
        if (recovery.kind === 'liable_retained') {
          transaction.set(
            reservationRef,
            settledFromExpiredLiable(existing, now, this.idempotencyTtlMs),
          );
          return {
            result: { accepted: false, reason: 'duplicate_operation' },
            recovery,
          };
        }
      }

      const balances: VectorBudgetRemaining[] = [];
      let limiting:
        | { dimensionKey: string; budgetKey: string; remaining: number }
        | undefined;
      for (const entry of entries) {
        for (const budgetEntry of entry.budgets) {
          const remaining = Math.max(
            0,
            budgetEntry.budget.limit - (usedById.get(budgetEntry.budgetId) ?? 0),
          );
          balances.push({
            dimensionKey: entry.dimension.key,
            budgetKey: budgetEntry.budget.key,
            remaining,
          });
          if (!limiting && entry.dimension.units > remaining) {
            limiting = {
              dimensionKey: entry.dimension.key,
              budgetKey: budgetEntry.budget.key,
              remaining,
            };
          }
        }
      }

      if (limiting) {
        if (recovery?.kind === 'pending_released') {
          writeUsedBudgets(
            transaction,
            this.budgets(),
            usedById,
            existingBudgetIds,
            now,
          );
          transaction.delete(reservationRef);
        } else if (recovery?.kind === 'tombstone_deleted') {
          transaction.delete(reservationRef);
        }
        return {
          result: {
            accepted: false,
            reason: 'quota_exceeded',
            limitingDimensionKey: limiting.dimensionKey,
            limitingBudgetKey: limiting.budgetKey,
            remaining: limiting.remaining,
          },
          ...(recovery === undefined ? {} : { recovery }),
        };
      }

      for (const entry of entries) {
        for (const budgetEntry of entry.budgets) {
          usedById.set(
            budgetEntry.budgetId,
            safeAdd(
              usedById.get(budgetEntry.budgetId) ?? 0,
              entry.dimension.units,
              'vector budget usage',
            ),
          );
        }
      }
      const expiresAt = safeAdd(now, input.ttlMs, 'reservation expiry');
      const stored: StoredReservation = {
        schemaVersion: 1,
        mode: 'vector',
        state: 'pending',
        budgetIds: [],
        reservedUnits: 0,
        dimensions: entries.map(entry => ({
          dimensionHash: entry.dimensionHash,
          budgetIds: entry.budgets.map(budget => budget.budgetId),
          reservedUnits: entry.dimension.units,
        })),
        expiresAtMs: expiresAt,
        growthCursor: initialGrowthCursor,
      };
      const touchedBudgetIds = uniqueSorted([
        ...currentBudgetIds,
        ...(recovery?.kind === 'pending_released' ? existingBudgetIds : []),
      ]);
      writeUsedBudgets(transaction, this.budgets(), usedById, touchedBudgetIds, now);
      transaction.set(reservationRef, stored as unknown as Record<string, unknown>);
      return {
        result: {
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
            dimensions: dimensions.map(dimension => ({
              key: dimension.key,
              budgetKeys: dimension.budgets.map(budget => budget.key),
              reservedUnits: dimension.units,
            })),
            expiresAt,
            growthCursor: initialGrowthCursor,
          },
          remainingByBudget: balances.map(balance => {
            const units = dimensions.find(dimension => dimension.key === balance.dimensionKey)!.units;
            return { ...balance, remaining: balance.remaining - units };
          }),
        },
        ...(recovery === undefined ? {} : { recovery }),
      };
    });

    if (transactionResult.recovery) {
      this.emitRecovery(transactionResult.recovery, reservationId, now);
    }
    return transactionResult.result;
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
    const budgetEntries = budgets.map(budget => ({ budget, budgetId: digest(budget.key) }));
    const currentBudgetIds = budgetEntries.map(entry => entry.budgetId);
    const budgetById = new Map(budgetEntries.map(entry => [entry.budgetId, entry.budget] as const));
    const incrementHash = digest(input.incrementId);
    const fingerprint = digest(
      JSON.stringify([
        input.additionalUnits,
        budgetEntries.map(entry => [entry.budgetId, entry.budget.limit]),
      ]),
    );
    // Generated outside the callback so automatic Firestore transaction retries reuse one value.
    const nextGrowthCursor = newGrowthCursor();
    const now = this.nowMs();
    const reference = this.reservations().doc(input.reservationId);

    const transactionResult = await this.runTransaction<
      | { ok: true; result: StoreGrowResult }
      | {
          ok: false;
          reason: 'missing' | 'terminal' | 'conflict' | 'stale_cursor' | 'budget_mismatch' | 'not_supported' | 'mode_mismatch';
          recovery?: RecoveryResult;
        }
    >(async transaction => {
      const snapshot = await transaction.get(reference);
      const reservation = readReservation(snapshot);
      if (!reservation) return { ok: false, reason: 'missing' };

      if (this.isExpired(reservation, now)) {
        const recovery = await recoverExpiredReservation(
          transaction,
          reference,
          this.budgets(),
          reservation,
          now,
          this.idempotencyTtlMs,
        );
        return { ok: false, reason: 'missing', recovery };
      }
      if (reservation.state === 'settled') return { ok: false, reason: 'terminal' };
      if (isVectorReservation(reservation)) return { ok: false, reason: 'mode_mismatch' };

      const lastGrowth = reservation.lastGrowth;
      if (lastGrowth?.incrementHash === incrementHash) {
        if (
          lastGrowth.expectedGrowthCursor !== input.expectedGrowthCursor ||
          lastGrowth.fingerprint !== fingerprint
        ) {
          return { ok: false, reason: 'conflict' };
        }
        return {
          ok: true,
          result: growthResultFromStored(
            input.reservationId,
            input.incrementId,
            lastGrowth,
            budgetById,
            true,
          ),
        };
      }

      if (!reservation.growthCursor) return { ok: false, reason: 'not_supported' };
      if (reservation.growthCursor !== input.expectedGrowthCursor) {
        return { ok: false, reason: 'stale_cursor' };
      }
      if (!sameStringArray(reservation.budgetIds, currentBudgetIds)) {
        return { ok: false, reason: 'budget_mismatch' };
      }

      const usedById = await readBudgets(transaction, this.budgets(), currentBudgetIds);
      const remainingByBudgetIds = budgetEntries.map(entry => ({
        budgetId: entry.budgetId,
        remaining: Math.max(0, entry.budget.limit - (usedById.get(entry.budgetId) ?? 0)),
      }));
      const limiting = remainingByBudgetIds.find(
        balance => input.additionalUnits > balance.remaining,
      );

      if (limiting) {
        const last: StoredGrowthReplay = {
          incrementHash,
          expectedGrowthCursor: input.expectedGrowthCursor,
          fingerprint,
          nextGrowthCursor,
          accepted: false,
          limitingBudgetId: limiting.budgetId,
          remaining: limiting.remaining,
        };
        transaction.set(reference, {
          ...reservation,
          growthCursor: nextGrowthCursor,
          lastGrowth: last,
        } as unknown as Record<string, unknown>);
        return {
          ok: true,
          result: growthResultFromStored(
            input.reservationId,
            input.incrementId,
            last,
            budgetById,
            false,
          ),
        };
      }

      for (const budgetId of currentBudgetIds) {
        usedById.set(
          budgetId,
          safeAdd(usedById.get(budgetId) ?? 0, input.additionalUnits, 'budget usage'),
        );
      }
      writeUsedBudgets(transaction, this.budgets(), usedById, currentBudgetIds, now);

      const previousReservedUnits = reservation.reservedUnits;
      const reservedUnits = safeAdd(previousReservedUnits, input.additionalUnits, 'reservedUnits');
      const acceptedBalances = remainingByBudgetIds.map(balance => ({
        budgetId: balance.budgetId,
        remaining: balance.remaining - input.additionalUnits,
      }));
      const last: StoredGrowthReplay = {
        incrementHash,
        expectedGrowthCursor: input.expectedGrowthCursor,
        fingerprint,
        nextGrowthCursor,
        accepted: true,
        previousReservedUnits,
        reservedUnits,
        remainingByBudgetIds: acceptedBalances,
      };
      transaction.set(reference, {
        ...reservation,
        reservedUnits,
        growthCursor: nextGrowthCursor,
        lastGrowth: last,
      } as unknown as Record<string, unknown>);
      return {
        ok: true,
        result: growthResultFromStored(
          input.reservationId,
          input.incrementId,
          last,
          budgetById,
          false,
        ),
      };
    });

    if (!transactionResult.ok) {
      if (transactionResult.recovery) {
        this.emitRecovery(transactionResult.recovery, input.reservationId, now);
      }
      if (transactionResult.reason === 'conflict') {
        throw new UsageStateError('Growth increment was already attempted with different parameters');
      }
      if (transactionResult.reason === 'stale_cursor') {
        throw new UsageStateError('Growth cursor is stale or conflicts with reservation state');
      }
      if (transactionResult.reason === 'budget_mismatch') {
        throw new UsageStateError('Growth budgets must exactly match the reservation budget set');
      }
      if (transactionResult.reason === 'not_supported') {
        throw new UsageStateError('Reservation does not support progressive growth');
      }
      if (transactionResult.reason === 'mode_mismatch') {
        throw new UsageStateError('Scalar growth cannot target a vector reservation');
      }
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    return transactionResult.result;
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
    const entries = dimensions.map(dimension => ({
      dimension,
      dimensionHash: digest(dimension.key),
      budgets: dimension.budgets.map(budget => ({ budget, budgetId: digest(budget.key) })),
    }));
    const currentBudgetIds = entries.flatMap(entry => entry.budgets.map(budget => budget.budgetId));
    const dimensionByHash = new Map(entries.map(entry => [entry.dimensionHash, entry.dimension] as const));
    const budgetById = new Map(
      entries.flatMap(entry => entry.budgets.map(budget => [budget.budgetId, budget.budget] as const)),
    );
    const incrementHash = digest(input.incrementId);
    const fingerprint = digest(
      JSON.stringify(
        entries.map(entry => [
          entry.dimensionHash,
          entry.dimension.additionalUnits,
          entry.budgets.map(budget => [budget.budgetId, budget.budget.limit]),
        ]),
      ),
    );
    const nextGrowthCursor = newGrowthCursor();
    const now = this.nowMs();
    const reference = this.reservations().doc(input.reservationId);

    const transactionResult = await this.runTransaction<
      | { ok: true; result: StoreVectorGrowResult }
      | {
          ok: false;
          reason:
            | 'missing'
            | 'terminal'
            | 'conflict'
            | 'stale_cursor'
            | 'dimension_mismatch'
            | 'not_supported'
            | 'mode_mismatch';
          recovery?: RecoveryResult;
        }
    >(async transaction => {
      const snapshot = await transaction.get(reference);
      const reservation = readReservation(snapshot);
      if (!reservation) return { ok: false, reason: 'missing' };
      if (this.isExpired(reservation, now)) {
        const recovery = await recoverExpiredReservation(
          transaction,
          reference,
          this.budgets(),
          reservation,
          now,
          this.idempotencyTtlMs,
        );
        return { ok: false, reason: 'missing', recovery };
      }
      if (reservation.state === 'settled') return { ok: false, reason: 'terminal' };
      if (!isVectorReservation(reservation)) return { ok: false, reason: 'mode_mismatch' };

      const lastGrowth = reservation.lastVectorGrowth;
      if (lastGrowth?.incrementHash === incrementHash) {
        if (
          lastGrowth.expectedGrowthCursor !== input.expectedGrowthCursor ||
          lastGrowth.fingerprint !== fingerprint
        ) {
          return { ok: false, reason: 'conflict' };
        }
        return {
          ok: true,
          result: vectorGrowthResultFromStored(
            input.reservationId,
            input.incrementId,
            lastGrowth,
            dimensionByHash,
            budgetById,
            true,
          ),
        };
      }

      if (!reservation.growthCursor) return { ok: false, reason: 'not_supported' };
      if (reservation.growthCursor !== input.expectedGrowthCursor) {
        return { ok: false, reason: 'stale_cursor' };
      }
      if (!sameStoredVectorGrowthTopology(reservation.dimensions!, entries)) {
        return { ok: false, reason: 'dimension_mismatch' };
      }

      const usedById = await readBudgets(transaction, this.budgets(), currentBudgetIds);
      const remainingByBudgetIds: NonNullable<StoredVectorGrowthReplay['remainingByBudgetIds']> = [];
      let limiting:
        | { dimensionHash: string; budgetId: string; remaining: number }
        | undefined;
      for (const entry of entries) {
        for (const budgetEntry of entry.budgets) {
          const remaining = Math.max(
            0,
            budgetEntry.budget.limit - (usedById.get(budgetEntry.budgetId) ?? 0),
          );
          remainingByBudgetIds.push({
            dimensionHash: entry.dimensionHash,
            budgetId: budgetEntry.budgetId,
            remaining,
          });
          if (!limiting && entry.dimension.additionalUnits > remaining) {
            limiting = {
              dimensionHash: entry.dimensionHash,
              budgetId: budgetEntry.budgetId,
              remaining,
            };
          }
        }
      }

      if (limiting) {
        const last: StoredVectorGrowthReplay = {
          incrementHash,
          expectedGrowthCursor: input.expectedGrowthCursor,
          fingerprint,
          nextGrowthCursor,
          accepted: false,
          limitingDimensionHash: limiting.dimensionHash,
          limitingBudgetId: limiting.budgetId,
          remaining: limiting.remaining,
        };
        transaction.set(reference, {
          ...reservation,
          growthCursor: nextGrowthCursor,
          lastVectorGrowth: last,
        } as unknown as Record<string, unknown>);
        return {
          ok: true,
          result: vectorGrowthResultFromStored(
            input.reservationId,
            input.incrementId,
            last,
            dimensionByHash,
            budgetById,
            false,
          ),
        };
      }

      const previousReservedByDimensions = reservation.dimensions!.map(dimension => ({
        dimensionHash: dimension.dimensionHash,
        reservedUnits: dimension.reservedUnits,
      }));
      const entryByHash = new Map(entries.map(entry => [entry.dimensionHash, entry] as const));
      const nextDimensions = reservation.dimensions!.map(dimension => {
        const entry = entryByHash.get(dimension.dimensionHash)!;
        for (const budgetEntry of entry.budgets) {
          usedById.set(
            budgetEntry.budgetId,
            safeAdd(
              usedById.get(budgetEntry.budgetId) ?? 0,
              entry.dimension.additionalUnits,
              'vector budget usage',
            ),
          );
        }
        return {
          ...dimension,
          reservedUnits: safeAdd(
            dimension.reservedUnits,
            entry.dimension.additionalUnits,
            'vector reservedUnits',
          ),
        };
      });
      const reservedByDimensions = nextDimensions.map(dimension => ({
        dimensionHash: dimension.dimensionHash,
        reservedUnits: dimension.reservedUnits,
      }));
      const adjustedRemaining = remainingByBudgetIds.map(balance => ({
        ...balance,
        remaining:
          balance.remaining -
          entryByHash.get(balance.dimensionHash)!.dimension.additionalUnits,
      }));
      const last: StoredVectorGrowthReplay = {
        incrementHash,
        expectedGrowthCursor: input.expectedGrowthCursor,
        fingerprint,
        nextGrowthCursor,
        accepted: true,
        previousReservedByDimensions,
        reservedByDimensions,
        remainingByBudgetIds: adjustedRemaining,
      };
      writeUsedBudgets(transaction, this.budgets(), usedById, currentBudgetIds, now);
      transaction.set(reference, {
        ...reservation,
        dimensions: nextDimensions,
        growthCursor: nextGrowthCursor,
        lastVectorGrowth: last,
      } as unknown as Record<string, unknown>);
      return {
        ok: true,
        result: vectorGrowthResultFromStored(
          input.reservationId,
          input.incrementId,
          last,
          dimensionByHash,
          budgetById,
          false,
        ),
      };
    });

    if (!transactionResult.ok) {
      if (transactionResult.recovery) {
        this.emitRecovery(transactionResult.recovery, input.reservationId, now);
      }
      if (transactionResult.reason === 'conflict') {
        throw new UsageStateError('Vector growth increment was already attempted with different parameters');
      }
      if (transactionResult.reason === 'stale_cursor') {
        throw new UsageStateError('Vector growth cursor is stale or conflicts with reservation state');
      }
      if (transactionResult.reason === 'dimension_mismatch') {
        throw new UsageStateError('Vector growth dimensions and budgets must match the reservation');
      }
      if (transactionResult.reason === 'not_supported') {
        throw new UsageStateError('Vector reservation does not support progressive growth');
      }
      if (transactionResult.reason === 'mode_mismatch') {
        throw new UsageStateError('Vector growth cannot target a scalar reservation');
      }
      throw new UsageStateError('Reservation not found, expired, or no longer active');
    }
    return transactionResult.result;
  }

  async markLiable(input: MarkLiableInput): Promise<MarkLiableResult> {
    assertReservationId(input.reservationId);
    const now = this.nowMs();
    const result = await this.withActiveReservation(
      input.reservationId,
      now,
      (transaction, reference, reservation) => {
        transaction.set(reference, { ...reservation, state: 'liable' });
        return {
          reservationId: input.reservationId,
          expiresAt: reservation.expiresAtMs,
        };
      },
    );
    if (!result.ok) throw new UsageStateError('Active reservation not found or expired');
    return result.value;
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertReservationId(input.reservationId);
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const now = this.nowMs();
    const result = await this.withActiveReservation(
      input.reservationId,
      now,
      (transaction, reference, reservation) => {
        const expiresAt = safeAdd(now, input.ttlMs, 'reservation expiry');
        transaction.set(reference, { ...reservation, expiresAtMs: expiresAt });
        return { reservationId: input.reservationId, expiresAt };
      },
    );
    if (!result.ok) throw new UsageStateError('Active reservation not found or expired');
    return result.value;
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertReservationId(input.reservationId);
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    const now = this.nowMs();
    const reference = this.reservations().doc(input.reservationId);
    const outcomeHash = digest(input.outcome);

    const transactionResult = await this.runTransaction<
      | { ok: true; settlement: SettlementResult }
      | {
          ok: false;
          reason: 'missing' | 'invalid_units' | 'conflict' | 'mode_mismatch';
          recovery?: RecoveryResult;
        }
    >(async transaction => {
      const snapshot = await transaction.get(reference);
      const reservation = readReservation(snapshot);
      if (!reservation) return { ok: false, reason: 'missing' };

      if (this.isExpired(reservation, now)) {
        const recovery = await recoverExpiredReservation(
          transaction,
          reference,
          this.budgets(),
          reservation,
          now,
          this.idempotencyTtlMs,
        );
        return { ok: false, reason: 'missing', recovery };
      }

      if (isVectorReservation(reservation)) {
        return { ok: false, reason: 'mode_mismatch' };
      }

      if (reservation.state === 'settled') {
        if (
          reservation.actualUnits !== input.actualUnits ||
          reservation.outcomeHash !== outcomeHash
        ) {
          return { ok: false, reason: 'conflict' };
        }
        return {
          ok: true,
          settlement: {
            reservationId: input.reservationId,
            reservedUnits: reservation.reservedUnits,
            actualUnits: input.actualUnits,
            releasedUnits: reservation.reservedUnits - input.actualUnits,
            outcome: input.outcome,
          },
        };
      }

      if (input.actualUnits > reservation.reservedUnits) {
        return { ok: false, reason: 'invalid_units' };
      }

      const releasedUnits = reservation.reservedUnits - input.actualUnits;
      if (releasedUnits > 0) {
        const usedById = await readBudgets(
          transaction,
          this.budgets(),
          reservation.budgetIds,
        );
        releaseAcrossBudgets(usedById, reservation.budgetIds, releasedUnits);
        writeUsedBudgets(
          transaction,
          this.budgets(),
          usedById,
          reservation.budgetIds,
          now,
        );
      }

      transaction.set(reference, {
        ...reservation,
        state: 'settled',
        expiresAtMs: safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry'),
        actualUnits: input.actualUnits,
        outcomeHash,
      } as unknown as Record<string, unknown>);

      return {
        ok: true,
        settlement: {
          reservationId: input.reservationId,
          reservedUnits: reservation.reservedUnits,
          actualUnits: input.actualUnits,
          releasedUnits,
          outcome: input.outcome,
        },
      };
    });

    if (!transactionResult.ok) {
      if (transactionResult.recovery) {
        this.emitRecovery(transactionResult.recovery, input.reservationId, now);
      }
      if (transactionResult.reason === 'invalid_units') {
        throw new UsageStateError('actualUnits cannot exceed reservedUnits');
      }
      if (transactionResult.reason === 'conflict') {
        throw new UsageStateError('Reservation was already settled with a different result');
      }
      if (transactionResult.reason === 'mode_mismatch') {
        throw new UsageStateError('Scalar settlement cannot target a vector reservation');
      }
      throw new UsageStateError('Reservation not found or expired');
    }

    return transactionResult.settlement;
  }

  async settleVector(input: VectorSettleInput): Promise<VectorSettlementResult> {
    assertReservationId(input.reservationId);
    const actuals = canonicalizeActualDimensions(input.actualByDimension);
    const encodedActuals = actuals.map(actual => ({
      dimensionHash: digest(actual.key),
      actualUnits: actual.actualUnits,
    }));
    const keyByHash = new Map(encodedActuals.map((actual, index) => [actual.dimensionHash, actuals[index]!.key] as const));
    const outcomeHash = digest(input.outcome);
    const now = this.nowMs();
    const reference = this.reservations().doc(input.reservationId);

    const transactionResult = await this.runTransaction<
      | { ok: true; settlement: VectorSettlementResult }
      | {
          ok: false;
          reason: 'missing' | 'invalid_units' | 'conflict' | 'dimension_mismatch' | 'mode_mismatch';
          recovery?: RecoveryResult;
        }
    >(async transaction => {
      const snapshot = await transaction.get(reference);
      const reservation = readReservation(snapshot);
      if (!reservation) return { ok: false, reason: 'missing' };
      if (this.isExpired(reservation, now)) {
        const recovery = await recoverExpiredReservation(
          transaction,
          reference,
          this.budgets(),
          reservation,
          now,
          this.idempotencyTtlMs,
        );
        return { ok: false, reason: 'missing', recovery };
      }
      if (!isVectorReservation(reservation)) return { ok: false, reason: 'mode_mismatch' };
      if (!sameVectorActualTopology(reservation.dimensions!, encodedActuals)) {
        return { ok: false, reason: 'dimension_mismatch' };
      }

      if (reservation.state === 'settled') {
        if (
          reservation.outcomeHash !== outcomeHash ||
          !sameStoredVectorActuals(reservation.actualByDimensions, encodedActuals)
        ) {
          return { ok: false, reason: 'conflict' };
        }
        return {
          ok: true,
          settlement: vectorSettlementFromStored(
            input.reservationId,
            reservation,
            encodedActuals,
            keyByHash,
            input.outcome,
          ),
        };
      }

      for (let index = 0; index < reservation.dimensions!.length; index += 1) {
        if (encodedActuals[index]!.actualUnits > reservation.dimensions![index]!.reservedUnits) {
          return { ok: false, reason: 'invalid_units' };
        }
      }
      const budgetIds = reservationBudgetIds(reservation);
      const usedById = await readBudgets(transaction, this.budgets(), budgetIds);
      for (let index = 0; index < reservation.dimensions!.length; index += 1) {
        const dimension = reservation.dimensions![index]!;
        const released = dimension.reservedUnits - encodedActuals[index]!.actualUnits;
        if (released > 0) releaseAcrossBudgets(usedById, dimension.budgetIds, released);
      }
      writeUsedBudgets(transaction, this.budgets(), usedById, budgetIds, now);
      const settledReservation: StoredReservation = {
        ...reservation,
        state: 'settled',
        expiresAtMs: safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry'),
        actualByDimensions: encodedActuals,
        outcomeHash,
      };
      transaction.set(reference, settledReservation as unknown as Record<string, unknown>);
      return {
        ok: true,
        settlement: vectorSettlementFromStored(
          input.reservationId,
          settledReservation,
          encodedActuals,
          keyByHash,
          input.outcome,
        ),
      };
    });

    if (!transactionResult.ok) {
      if (transactionResult.recovery) {
        this.emitRecovery(transactionResult.recovery, input.reservationId, now);
      }
      if (transactionResult.reason === 'invalid_units') {
        throw new UsageStateError('actualUnits cannot exceed reservedUnits for a vector dimension');
      }
      if (transactionResult.reason === 'conflict') {
        throw new UsageStateError('Vector reservation was already settled with a different result');
      }
      if (transactionResult.reason === 'dimension_mismatch') {
        throw new UsageStateError('Vector settlement dimensions must exactly match the reservation');
      }
      if (transactionResult.reason === 'mode_mismatch') {
        throw new UsageStateError('Vector settlement cannot target a scalar reservation');
      }
      throw new UsageStateError('Reservation not found or expired');
    }
    return transactionResult.settlement;
  }

  /**
   * Reclaim a bounded batch of expired reservations/tombstones.
   *
   * A scheduler may call this explicitly. `reserve()` also invokes a throttled,
   * best-effort pass so abandoned pending reservations do not hold capacity forever.
   */
  async recoverExpired(
    limit = this.cleanupBatchSize || 16,
  ): Promise<FirestoreRecoverySummary> {
    assertPositiveInteger(limit, 'limit');
    const now = this.nowMs();
    const cutoff = now - this.expiryGraceMs;
    const snapshot = await this.reservations()
      .where('expiresAtMs', '<=', cutoff)
      .limit(limit)
      .get();
    const summary: FirestoreRecoverySummary = {
      pendingCount: 0,
      pendingUnits: 0,
      liableCount: 0,
      liableUnits: 0,
      vectorPendingCount: 0,
      vectorLiableCount: 0,
      tombstonesDeleted: 0,
    };

    for (const document of snapshot.docs) {
      const recovery = await this.recoverReservation(document.ref.id, now);
      if (recovery.kind === 'pending_released') {
        if (recovery.vector) summary.vectorPendingCount += 1;
        else {
          summary.pendingCount += 1;
          summary.pendingUnits += recovery.reservedUnits;
        }
        this.emitRecovery(recovery, document.ref.id, now);
      } else if (recovery.kind === 'liable_retained') {
        if (recovery.vector) summary.vectorLiableCount += 1;
        else {
          summary.liableCount += 1;
          summary.liableUnits += recovery.reservedUnits;
        }
        this.emitRecovery(recovery, document.ref.id, now);
      } else if (recovery.kind === 'tombstone_deleted') {
        summary.tombstonesDeleted += 1;
      }
    }
    return summary;
  }

  private async withActiveReservation<T>(
    reservationId: string,
    now: number,
    mutate: (
      transaction: FirestoreTransactionLike,
      reference: FirestoreDocumentReferenceLike,
      reservation: StoredReservation,
    ) => T,
  ): Promise<ActiveTransactionResult<T> | FailedActiveTransactionResult> {
    const reference = this.reservations().doc(reservationId);
    const result = await this.runTransaction<
      ActiveTransactionResult<T> | FailedActiveTransactionResult
    >(async transaction => {
      const snapshot = await transaction.get(reference);
      const reservation = readReservation(snapshot);
      if (!reservation || reservation.state === 'settled') return { ok: false };

      // The common path touches only the reservation document. In particular,
      // heartbeat renewals must not read a shared tenant budget and turn it into
      // an unnecessary contention point. Participating budgets are read only if
      // an expired pending reservation actually needs capacity released.
      if (!this.isExpired(reservation, now)) {
        return { ok: true, value: mutate(transaction, reference, reservation) };
      }

      const recovery = await recoverExpiredReservation(
        transaction,
        reference,
        this.budgets(),
        reservation,
        now,
        this.idempotencyTtlMs,
      );
      return { ok: false, recovery };
    });

    if (!result.ok && result.recovery) {
      this.emitRecovery(result.recovery, reservationId, now);
    }
    return result;
  }

  private async recoverReservation(
    reservationId: string,
    now: number,
  ): Promise<RecoveryResult> {
    if (!RESERVATION_ID_PATTERN.test(reservationId)) {
      return { kind: 'none', reservedUnits: 0 };
    }
    const reference = this.reservations().doc(reservationId);
    return this.runTransaction<RecoveryResult>(async transaction => {
      const snapshot = await transaction.get(reference);
      const reservation = readReservation(snapshot);
      if (!reservation || !this.isExpired(reservation, now)) {
        return { kind: 'none', reservedUnits: 0 };
      }

      return recoverExpiredReservation(
        transaction,
        reference,
        this.budgets(),
        reservation,
        now,
        this.idempotencyTtlMs,
      );
    });
  }

  private async maybeCleanup(now: number): Promise<void> {
    if (this.cleanupBatchSize === 0) return;
    if (now - this.lastCleanupStartedAt < this.cleanupIntervalMs) return;
    this.lastCleanupStartedAt = now;
    try {
      await this.recoverExpired(this.cleanupBatchSize);
    } catch {
      // Cleanup failure can only leave stale capacity reserved; it cannot increase
      // admission capacity. The authoritative reserve transaction still runs and
      // therefore remains fail-closed with respect to quota oversubscription.
    }
  }

  private isExpired(reservation: StoredReservation, now: number): boolean {
    return reservation.expiresAtMs <= now - this.expiryGraceMs;
  }

  private emitRecovery(
    recovery: RecoveryResult,
    reservationId: string,
    now: number,
  ): void {
    if (
      recovery.kind !== 'pending_released' &&
      recovery.kind !== 'liable_retained'
    ) {
      return;
    }
    if (recovery.vector) {
      emitFirestoreRecovery(this.observer, {
        type: 'vector.reservation.recovered',
        timestamp: now,
        store: 'firestore',
        recovery: recovery.kind,
        reservationId,
        dimensionCount: recovery.vector.dimensionCount,
        budgetCount: recovery.vector.budgetCount,
        count: 1,
      });
      return;
    }
    emitFirestoreRecovery(this.observer, {
      type: 'reservation.recovered',
      timestamp: now,
      store: 'firestore',
      recovery: recovery.kind,
      reservationId,
      reservedUnits: recovery.reservedUnits,
      count: 1,
    });
  }

  private runTransaction<T>(
    updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>,
  ): Promise<T> {
    return this.firestore.runTransaction(updateFunction);
  }

  private budgets(): FirestoreCollectionReferenceLike {
    return this.firestore.collection(`${this.prefix}_budgets`) as FirestoreCollectionReferenceLike;
  }

  private reservations(): FirestoreCollectionReferenceLike {
    return this.firestore.collection(`${this.prefix}_reservations`) as FirestoreCollectionReferenceLike;
  }

  private nowMs(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UsageStateError('Firestore usage store clock returned an invalid timestamp');
    }
    return value;
  }
}

function emitFirestoreRecovery(
  observer: FirestoreRecoveryObserver | undefined,
  event: FirestoreRecoveryEvent,
): void {
  if (!observer) return;
  try {
    const result = observer.onEvent(event);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Observability remains best-effort and never changes enforcement state.
  }
}

async function recoverExpiredReservation(
  transaction: FirestoreTransactionLike,
  reservationRef: FirestoreDocumentReferenceLike,
  budgetCollection: FirestoreCollectionReferenceLike,
  reservation: StoredReservation,
  now: number,
  idempotencyTtlMs: number,
): Promise<RecoveryResult> {
  if (reservation.state === 'pending') {
    const budgetIds = reservationBudgetIds(reservation);
    const usedById = await readBudgets(transaction, budgetCollection, budgetIds);
    releaseReservationAcrossBudgets(usedById, reservation);
    writeUsedBudgets(transaction, budgetCollection, usedById, budgetIds, now);
    transaction.delete(reservationRef);
    return recoveryResult('pending_released', reservation);
  }

  if (reservation.state === 'liable') {
    transaction.set(
      reservationRef,
      settledFromExpiredLiable(reservation, now, idempotencyTtlMs),
    );
    return recoveryResult('liable_retained', reservation);
  }

  transaction.delete(reservationRef);
  return { kind: 'tombstone_deleted', reservedUnits: 0 };
}

function recoverStoredReservation(
  reservation: StoredReservation,
  usedById: Map<string, number>,
): RecoveryResult {
  if (reservation.state === 'pending') {
    releaseReservationAcrossBudgets(usedById, reservation);
    return recoveryResult('pending_released', reservation);
  }
  if (reservation.state === 'liable') {
    return recoveryResult('liable_retained', reservation);
  }
  return { kind: 'tombstone_deleted', reservedUnits: 0 };
}

function settledFromExpiredLiable(
  reservation: StoredReservation,
  now: number,
  idempotencyTtlMs: number,
): Record<string, unknown> {
  const base = {
    ...reservation,
    state: 'settled',
    expiresAtMs: safeAdd(now, idempotencyTtlMs, 'tombstone expiry'),
    outcomeHash: digest(EXPIRED_LIABLE_OUTCOME),
  };
  if (isVectorReservation(reservation)) {
    return {
      ...base,
      actualByDimensions: reservation.dimensions!.map(dimension => ({
        dimensionHash: dimension.dimensionHash,
        actualUnits: dimension.reservedUnits,
      })),
    };
  }
  return { ...base, actualUnits: reservation.reservedUnits };
}

function isVectorReservation(reservation: StoredReservation): boolean {
  return reservation.mode === 'vector';
}

function reservationBudgetIds(reservation: StoredReservation): string[] {
  if (!isVectorReservation(reservation)) return [...reservation.budgetIds];
  return uniqueSorted(
    reservation.dimensions!.flatMap(dimension => dimension.budgetIds),
  );
}

function releaseReservationAcrossBudgets(
  usedById: Map<string, number>,
  reservation: StoredReservation,
): void {
  if (!isVectorReservation(reservation)) {
    releaseAcrossBudgets(usedById, reservation.budgetIds, reservation.reservedUnits);
    return;
  }
  for (const dimension of reservation.dimensions!) {
    releaseAcrossBudgets(usedById, dimension.budgetIds, dimension.reservedUnits);
  }
}

function recoveryResult(
  kind: 'pending_released' | 'liable_retained',
  reservation: StoredReservation,
): RecoveryResult {
  if (isVectorReservation(reservation)) {
    return {
      kind,
      reservedUnits: 0,
      vector: {
        dimensionCount: reservation.dimensions!.length,
        budgetCount: reservationBudgetIds(reservation).length,
      },
    };
  }
  return { kind, reservedUnits: reservation.reservedUnits };
}

async function readBudgets(
  transaction: FirestoreTransactionLike,
  collection: FirestoreCollectionReferenceLike,
  budgetIds: readonly string[],
): Promise<Map<string, number>> {
  const normalized = uniqueSorted(budgetIds);
  if (normalized.length === 0) return new Map();
  const references = normalized.map(id => collection.doc(id));
  const snapshots = await transaction.getAll(...references);
  const usedById = new Map<string, number>();
  for (let index = 0; index < normalized.length; index += 1) {
    usedById.set(normalized[index]!, readBudgetUsed(snapshots[index]));
  }
  return usedById;
}

function writeUsedBudgets(
  transaction: FirestoreTransactionLike,
  collection: FirestoreCollectionReferenceLike,
  usedById: ReadonlyMap<string, number>,
  budgetIds: readonly string[],
  now: number,
): void {
  for (const budgetId of uniqueSorted(budgetIds)) {
    const used = usedById.get(budgetId) ?? 0;
    const reference = collection.doc(budgetId);
    if (used === 0) {
      transaction.delete(reference);
    } else {
      transaction.set(reference, {
        schemaVersion: 1,
        used,
        updatedAtMs: now,
      });
    }
  }
}

function releaseAcrossBudgets(
  usedById: Map<string, number>,
  budgetIds: readonly string[],
  units: number,
): void {
  for (const budgetId of budgetIds) {
    const current = usedById.get(budgetId) ?? 0;
    usedById.set(budgetId, Math.max(0, current - units));
  }
}

function readReservation(
  snapshot: FirestoreDocumentSnapshotLike,
): StoredReservation | undefined {
  if (!snapshot.exists) return undefined;
  const data = snapshot.data();
  if (!data) throw new UsageStateError('Firestore reservation document had no data');
  if (data.schemaVersion !== 1) {
    throw new UsageStateError('Unsupported Firestore reservation schema version');
  }
  const state = data.state;
  if (state !== 'pending' && state !== 'liable' && state !== 'settled') {
    throw new UsageStateError('Firestore reservation document had an invalid state');
  }
  if (data.mode !== undefined && data.mode !== 'vector') {
    throw new UsageStateError('Firestore reservation document had an invalid mode');
  }
  const budgetIds = data.budgetIds;
  if (
    !Array.isArray(budgetIds) ||
    !budgetIds.every(value => typeof value === 'string' && HASH_PATTERN.test(value))
  ) {
    throw new UsageStateError('Firestore reservation document had invalid budget IDs');
  }
  if (new Set(budgetIds).size !== budgetIds.length) {
    throw new UsageStateError('Firestore reservation document had duplicate budget IDs');
  }
  const reservedUnits = readSafeNonNegativeInteger(data.reservedUnits, 'reservedUnits');
  const expiresAtMs = readSafeNonNegativeInteger(data.expiresAtMs, 'expiresAtMs');

  const result: StoredReservation = {
    schemaVersion: 1,
    state,
    budgetIds: [...budgetIds],
    reservedUnits,
    expiresAtMs,
  };
  if (data.mode === 'vector') {
    result.mode = 'vector';
    result.dimensions = readStoredVectorDimensions(data.dimensions);
    if (budgetIds.length !== 0 || reservedUnits !== 0) {
      throw new UsageStateError('Firestore vector reservation had non-empty scalar accounting fields');
    }
  }
  if (data.actualUnits !== undefined) {
    result.actualUnits = readSafeNonNegativeInteger(data.actualUnits, 'actualUnits');
  }
  if (data.outcomeHash !== undefined) {
    if (typeof data.outcomeHash !== 'string' || !HASH_PATTERN.test(data.outcomeHash)) {
      throw new UsageStateError('Firestore reservation document had an invalid outcome hash');
    }
    result.outcomeHash = data.outcomeHash;
  }
  if (data.growthCursor !== undefined) {
    if (typeof data.growthCursor !== 'string' || data.growthCursor.length === 0) {
      throw new UsageStateError('Firestore reservation document had an invalid growth cursor');
    }
    result.growthCursor = data.growthCursor;
  }
  if (data.lastGrowth !== undefined) result.lastGrowth = readStoredGrowthReplay(data.lastGrowth);
  if (data.actualByDimensions !== undefined) {
    result.actualByDimensions = readStoredVectorActuals(data.actualByDimensions);
  }
  if (data.lastVectorGrowth !== undefined) {
    result.lastVectorGrowth = readStoredVectorGrowthReplay(data.lastVectorGrowth);
  }

  if (isVectorReservation(result)) {
    if (result.actualUnits !== undefined || result.lastGrowth !== undefined) {
      throw new UsageStateError('Firestore vector reservation contained scalar lifecycle metadata');
    }
    if (
      result.actualByDimensions !== undefined &&
      !sameVectorActualTopology(result.dimensions!, result.actualByDimensions)
    ) {
      throw new UsageStateError('Firestore vector reservation had invalid actual dimensions');
    }
    if (state === 'settled' && (!result.actualByDimensions || !result.outcomeHash)) {
      throw new UsageStateError('Firestore settled vector reservation was incomplete');
    }
  } else {
    if (result.dimensions || result.actualByDimensions || result.lastVectorGrowth) {
      throw new UsageStateError('Firestore scalar reservation contained vector metadata');
    }
    if (state === 'settled' && (result.actualUnits === undefined || result.outcomeHash === undefined)) {
      throw new UsageStateError('Firestore settled reservation was incomplete');
    }
  }
  return result;
}

function readStoredVectorDimensions(value: unknown): StoredVectorDimension[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageStateError('Firestore vector reservation had invalid dimensions');
  }
  const dimensions = value.map(item => {
    if (!item || typeof item !== 'object') {
      throw new UsageStateError('Firestore vector reservation had invalid dimension data');
    }
    const data = item as Record<string, unknown>;
    if (typeof data.dimensionHash !== 'string' || !HASH_PATTERN.test(data.dimensionHash)) {
      throw new UsageStateError('Firestore vector reservation had invalid dimension hash');
    }
    if (
      !Array.isArray(data.budgetIds) ||
      data.budgetIds.length === 0 ||
      !data.budgetIds.every(id => typeof id === 'string' && HASH_PATTERN.test(id))
    ) {
      throw new UsageStateError('Firestore vector reservation had invalid dimension budget IDs');
    }
    const budgetIds = [...data.budgetIds] as string[];
    if (new Set(budgetIds).size !== budgetIds.length) {
      throw new UsageStateError('Firestore vector reservation had duplicate dimension budget IDs');
    }
    return {
      dimensionHash: data.dimensionHash,
      budgetIds,
      reservedUnits: readSafeNonNegativeInteger(data.reservedUnits, 'vector reservedUnits'),
    };
  });
  if (new Set(dimensions.map(item => item.dimensionHash)).size !== dimensions.length) {
    throw new UsageStateError('Firestore vector reservation had duplicate dimensions');
  }
  const allBudgetIds = dimensions.flatMap(item => item.budgetIds);
  if (new Set(allBudgetIds).size !== allBudgetIds.length) {
    throw new UsageStateError('Firestore budget ID appeared in multiple vector dimensions');
  }
  return dimensions;
}

function readStoredVectorActuals(value: unknown): Array<{ dimensionHash: string; actualUnits: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageStateError('Firestore vector actual dimensions were invalid');
  }
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new UsageStateError('Firestore vector actual entry was invalid');
    const data = item as Record<string, unknown>;
    if (typeof data.dimensionHash !== 'string' || !HASH_PATTERN.test(data.dimensionHash)) {
      throw new UsageStateError('Firestore vector actual entry had invalid dimension hash');
    }
    return {
      dimensionHash: data.dimensionHash,
      actualUnits: readSafeNonNegativeInteger(data.actualUnits, 'vector actualUnits'),
    };
  });
}

function sameVectorActualTopology(
  dimensions: readonly StoredVectorDimension[],
  actuals: readonly { dimensionHash: string }[],
): boolean {
  return (
    dimensions.length === actuals.length &&
    dimensions.every((dimension, index) => dimension.dimensionHash === actuals[index]!.dimensionHash)
  );
}

function readBudgetUsed(
  snapshot: FirestoreDocumentSnapshotLike | undefined,
): number {
  if (!snapshot || !snapshot.exists) return 0;
  const data = snapshot.data();
  if (!data) throw new UsageStateError('Firestore budget document had no data');
  if (data.schemaVersion !== 1) {
    throw new UsageStateError('Unsupported Firestore budget schema version');
  }
  return readSafeNonNegativeInteger(data.used, 'budget used');
}

function newGrowthCursor(): string {
  return `g1.${randomUUID()}`;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function growthResultFromStored(
  reservationId: string,
  incrementId: string,
  growth: StoredGrowthReplay,
  budgetById: ReadonlyMap<string, Budget>,
  replayed: boolean,
): StoreGrowResult {
  if (growth.accepted) {
    if (
      growth.previousReservedUnits === undefined ||
      growth.reservedUnits === undefined ||
      growth.remainingByBudgetIds === undefined
    ) {
      throw new UsageStateError('Firestore stored accepted growth result was incomplete');
    }
    return {
      accepted: true,
      replayed,
      reservationId,
      incrementId,
      previousReservedUnits: growth.previousReservedUnits,
      reservedUnits: growth.reservedUnits,
      growthCursor: growth.nextGrowthCursor,
      remainingByBudget: growth.remainingByBudgetIds.map(balance => {
        const budget = budgetById.get(balance.budgetId);
        if (!budget) throw new UsageStateError('Firestore growth replay referenced an unknown budget');
        return { key: budget.key, remaining: balance.remaining };
      }),
    };
  }
  if (growth.limitingBudgetId === undefined || growth.remaining === undefined) {
    throw new UsageStateError('Firestore stored denied growth result was incomplete');
  }
  const budget = budgetById.get(growth.limitingBudgetId);
  if (!budget) throw new UsageStateError('Firestore growth denial referenced an unknown budget');
  return {
    accepted: false,
    reason: 'quota_exceeded',
    replayed,
    reservationId,
    incrementId,
    growthCursor: growth.nextGrowthCursor,
    limitingBudgetKey: budget.key,
    remaining: growth.remaining,
  };
}

function readStoredGrowthReplay(value: unknown): StoredGrowthReplay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageStateError('Firestore reservation document had invalid growth replay metadata');
  }
  const data = value as Record<string, unknown>;
  for (const field of ['incrementHash', 'fingerprint'] as const) {
    if (typeof data[field] !== 'string' || !HASH_PATTERN.test(data[field])) {
      throw new UsageStateError(`Firestore growth replay had invalid ${field}`);
    }
  }
  for (const field of ['expectedGrowthCursor', 'nextGrowthCursor'] as const) {
    if (typeof data[field] !== 'string' || data[field].length === 0) {
      throw new UsageStateError(`Firestore growth replay had invalid ${field}`);
    }
  }
  if (typeof data.accepted !== 'boolean') {
    throw new UsageStateError('Firestore growth replay had invalid accepted state');
  }
  const result: StoredGrowthReplay = {
    incrementHash: data.incrementHash as string,
    expectedGrowthCursor: data.expectedGrowthCursor as string,
    fingerprint: data.fingerprint as string,
    nextGrowthCursor: data.nextGrowthCursor as string,
    accepted: data.accepted,
  };
  if (data.accepted) {
    result.previousReservedUnits = readSafeNonNegativeInteger(
      data.previousReservedUnits,
      'growth previousReservedUnits',
    );
    result.reservedUnits = readSafeNonNegativeInteger(data.reservedUnits, 'growth reservedUnits');
    if (!Array.isArray(data.remainingByBudgetIds)) {
      throw new UsageStateError('Firestore accepted growth replay had invalid balances');
    }
    result.remainingByBudgetIds = data.remainingByBudgetIds.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new UsageStateError('Firestore accepted growth replay had invalid balance');
      }
      const balance = entry as Record<string, unknown>;
      if (typeof balance.budgetId !== 'string' || !HASH_PATTERN.test(balance.budgetId)) {
        throw new UsageStateError('Firestore accepted growth replay had invalid budget ID');
      }
      return {
        budgetId: balance.budgetId,
        remaining: readSafeNonNegativeInteger(balance.remaining, 'growth remaining'),
      };
    });
  } else {
    if (typeof data.limitingBudgetId !== 'string' || !HASH_PATTERN.test(data.limitingBudgetId)) {
      throw new UsageStateError('Firestore denied growth replay had invalid budget ID');
    }
    result.limitingBudgetId = data.limitingBudgetId;
    result.remaining = readSafeNonNegativeInteger(data.remaining, 'growth remaining');
  }
  return result;
}

function sameStoredVectorGrowthTopology(
  stored: readonly StoredVectorDimension[],
  current: readonly {
    dimensionHash: string;
    budgets: readonly { budgetId: string }[];
  }[],
): boolean {
  return (
    stored.length === current.length &&
    stored.every((dimension, index) => {
      const candidate = current[index];
      return (
        candidate !== undefined &&
        dimension.dimensionHash === candidate.dimensionHash &&
        sameStringArray(
          dimension.budgetIds,
          candidate.budgets.map(budget => budget.budgetId),
        )
      );
    })
  );
}

function vectorGrowthResultFromStored(
  reservationId: string,
  incrementId: string,
  growth: StoredVectorGrowthReplay,
  dimensionByHash: ReadonlyMap<string, { key: string }>,
  budgetById: ReadonlyMap<string, Budget>,
  replayed: boolean,
): StoreVectorGrowResult {
  if (growth.accepted) {
    if (
      !growth.previousReservedByDimensions ||
      !growth.reservedByDimensions ||
      !growth.remainingByBudgetIds
    ) {
      throw new UsageStateError('Firestore stored accepted vector growth result was incomplete');
    }
    return {
      accepted: true,
      replayed,
      reservationId,
      incrementId,
      growthCursor: growth.nextGrowthCursor,
      previousReservedByDimension: mapStoredVectorReserved(
        growth.previousReservedByDimensions,
        dimensionByHash,
      ),
      reservedByDimension: mapStoredVectorReserved(
        growth.reservedByDimensions,
        dimensionByHash,
      ),
      remainingByBudget: growth.remainingByBudgetIds.map(balance => {
        const dimension = dimensionByHash.get(balance.dimensionHash);
        const budget = budgetById.get(balance.budgetId);
        if (!dimension || !budget) {
          throw new UsageStateError('Firestore vector growth replay referenced unknown identifiers');
        }
        return {
          dimensionKey: dimension.key,
          budgetKey: budget.key,
          remaining: balance.remaining,
        };
      }),
    };
  }
  if (
    !growth.limitingDimensionHash ||
    !growth.limitingBudgetId ||
    growth.remaining === undefined
  ) {
    throw new UsageStateError('Firestore stored denied vector growth result was incomplete');
  }
  const dimension = dimensionByHash.get(growth.limitingDimensionHash);
  const budget = budgetById.get(growth.limitingBudgetId);
  if (!dimension || !budget) {
    throw new UsageStateError('Firestore vector growth denial referenced unknown identifiers');
  }
  return {
    accepted: false,
    reason: 'quota_exceeded',
    replayed,
    reservationId,
    incrementId,
    growthCursor: growth.nextGrowthCursor,
    limitingDimensionKey: dimension.key,
    limitingBudgetKey: budget.key,
    remaining: growth.remaining,
  };
}

function mapStoredVectorReserved(
  values: readonly { dimensionHash: string; reservedUnits: number }[],
  dimensionByHash: ReadonlyMap<string, { key: string }>,
): UsageDimensionReserved[] {
  return values.map(value => {
    const dimension = dimensionByHash.get(value.dimensionHash);
    if (!dimension) {
      throw new UsageStateError('Firestore vector growth replay referenced an unknown dimension');
    }
    return { key: dimension.key, reservedUnits: value.reservedUnits };
  });
}

function sameStoredVectorActuals(
  left: readonly { dimensionHash: string; actualUnits: number }[] | undefined,
  right: readonly { dimensionHash: string; actualUnits: number }[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.dimensionHash === right[index]!.dimensionHash &&
        value.actualUnits === right[index]!.actualUnits,
    )
  );
}

function vectorSettlementFromStored(
  reservationId: string,
  reservation: StoredReservation,
  actuals: readonly { dimensionHash: string; actualUnits: number }[],
  keyByHash: ReadonlyMap<string, string>,
  outcome: string,
): VectorSettlementResult {
  if (!isVectorReservation(reservation)) {
    throw new UsageStateError('Expected vector reservation');
  }
  return {
    reservationId,
    dimensions: reservation.dimensions!.map((dimension, index) => {
      const key = keyByHash.get(dimension.dimensionHash);
      if (!key) throw new UsageStateError('Firestore vector settlement referenced an unknown dimension');
      const actualUnits = actuals[index]!.actualUnits;
      return {
        key,
        reservedUnits: dimension.reservedUnits,
        actualUnits,
        releasedUnits: dimension.reservedUnits - actualUnits,
      };
    }),
    outcome,
  };
}

function readStoredVectorGrowthReplay(value: unknown): StoredVectorGrowthReplay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageStateError('Firestore reservation document had invalid vector growth replay metadata');
  }
  const data = value as Record<string, unknown>;
  for (const field of ['incrementHash', 'fingerprint'] as const) {
    if (typeof data[field] !== 'string' || !HASH_PATTERN.test(data[field])) {
      throw new UsageStateError(`Firestore vector growth replay had invalid ${field}`);
    }
  }
  for (const field of ['expectedGrowthCursor', 'nextGrowthCursor'] as const) {
    if (typeof data[field] !== 'string' || data[field].length === 0) {
      throw new UsageStateError(`Firestore vector growth replay had invalid ${field}`);
    }
  }
  if (typeof data.accepted !== 'boolean') {
    throw new UsageStateError('Firestore vector growth replay had invalid accepted state');
  }
  const result: StoredVectorGrowthReplay = {
    incrementHash: data.incrementHash as string,
    expectedGrowthCursor: data.expectedGrowthCursor as string,
    fingerprint: data.fingerprint as string,
    nextGrowthCursor: data.nextGrowthCursor as string,
    accepted: data.accepted,
  };
  if (data.accepted) {
    result.previousReservedByDimensions = readStoredVectorReservedReplay(
      data.previousReservedByDimensions,
      'previous vector reservation',
    );
    result.reservedByDimensions = readStoredVectorReservedReplay(
      data.reservedByDimensions,
      'vector reservation',
    );
    if (!Array.isArray(data.remainingByBudgetIds)) {
      throw new UsageStateError('Firestore accepted vector growth replay had invalid balances');
    }
    result.remainingByBudgetIds = data.remainingByBudgetIds.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new UsageStateError('Firestore accepted vector growth replay had invalid balance');
      }
      const balance = entry as Record<string, unknown>;
      if (
        typeof balance.dimensionHash !== 'string' || !HASH_PATTERN.test(balance.dimensionHash) ||
        typeof balance.budgetId !== 'string' || !HASH_PATTERN.test(balance.budgetId)
      ) {
        throw new UsageStateError('Firestore accepted vector growth replay had invalid identifiers');
      }
      return {
        dimensionHash: balance.dimensionHash,
        budgetId: balance.budgetId,
        remaining: readSafeNonNegativeInteger(balance.remaining, 'vector growth remaining'),
      };
    });
  } else {
    if (
      typeof data.limitingDimensionHash !== 'string' || !HASH_PATTERN.test(data.limitingDimensionHash) ||
      typeof data.limitingBudgetId !== 'string' || !HASH_PATTERN.test(data.limitingBudgetId)
    ) {
      throw new UsageStateError('Firestore denied vector growth replay had invalid identifiers');
    }
    result.limitingDimensionHash = data.limitingDimensionHash;
    result.limitingBudgetId = data.limitingBudgetId;
    result.remaining = readSafeNonNegativeInteger(data.remaining, 'vector growth remaining');
  }
  return result;
}

function readStoredVectorReservedReplay(
  value: unknown,
  context: string,
): Array<{ dimensionHash: string; reservedUnits: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageStateError(`Firestore ${context} replay was invalid`);
  }
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new UsageStateError(`Firestore ${context} replay entry was invalid`);
    }
    const data = entry as Record<string, unknown>;
    if (typeof data.dimensionHash !== 'string' || !HASH_PATTERN.test(data.dimensionHash)) {
      throw new UsageStateError(`Firestore ${context} replay had invalid dimension hash`);
    }
    return {
      dimensionHash: data.dimensionHash,
      reservedUnits: readSafeNonNegativeInteger(data.reservedUnits, `${context} reservedUnits`),
    };
  });
}

function canonicalizeUsageDimensions(dimensions: readonly UsageDimension[]): UsageDimension[] {
  if (dimensions.length === 0) throw new RangeError('dimensions must contain at least one dimension');
  const normalized = dimensions.map(dimension => {
    if (!dimension.key) throw new RangeError('dimension.key must be non-empty');
    assertNonNegativeInteger(dimension.units, `dimension.units (${dimension.key})`);
    return { key: dimension.key, units: dimension.units, budgets: canonicalizeBudgets(dimension.budgets) };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  validateVectorTopology(normalized);
  return normalized;
}

function canonicalizeGrowthDimensions(dimensions: readonly UsageDimensionGrowth[]): UsageDimensionGrowth[] {
  if (dimensions.length === 0) throw new RangeError('dimensions must contain at least one dimension');
  const normalized = dimensions.map(dimension => {
    if (!dimension.key) throw new RangeError('dimension.key must be non-empty');
    assertNonNegativeInteger(dimension.additionalUnits, `dimension.additionalUnits (${dimension.key})`);
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

function canonicalizeActualDimensions(actuals: readonly UsageDimensionActual[]): UsageDimensionActual[] {
  if (actuals.length === 0) throw new RangeError('actualByDimension must contain at least one dimension');
  const normalized = actuals.map(actual => {
    if (!actual.key) throw new RangeError('actual dimension key must be non-empty');
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
  const dimensionsSeen = new Set<string>();
  const budgetsSeen = new Set<string>();
  for (const dimension of dimensions) {
    if (dimensionsSeen.has(dimension.key)) throw new RangeError(`duplicate dimension key: ${dimension.key}`);
    dimensionsSeen.add(dimension.key);
    for (const budget of dimension.budgets) {
      if (budgetsSeen.has(budget.key)) {
        throw new RangeError(`budget key cannot appear in multiple vector dimensions: ${budget.key}`);
      }
      budgetsSeen.add(budget.key);
    }
  }
}

function canonicalizeBudgets(budgets: readonly Budget[]): Budget[] {
  if (budgets.length === 0) {
    throw new RangeError('budgets must contain at least one budget');
  }
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

function reservationIdFor(request: UsageRequest): string {
  return `fs1.${digest(
    JSON.stringify([
      request.principal.tenantId ?? null,
      request.principal.id,
      request.tool,
      request.operationId,
    ]),
  )}`;
}

function assertReservationId(reservationId: string): void {
  if (!RESERVATION_ID_PATTERN.test(reservationId)) {
    throw new UsageStateError('Invalid Firestore reservation ID');
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function readSafeNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UsageStateError(`Firestore document had an invalid ${name}`);
  }
  return value;
}

function safeAdd(left: number, right: number, name: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageStateError(`${name} exceeded the safe integer range`);
  }
  return value;
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
