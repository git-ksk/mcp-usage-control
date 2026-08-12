import { createHash } from 'node:crypto';
import {
  UsageStateError,
  type Budget,
  type BudgetRemaining,
  type MarkLiableInput,
  type MarkLiableResult,
  type RenewInput,
  type RenewResult,
  type SettleInput,
  type SettlementResult,
  type StoreReserveResult,
  type UsageRequest,
  type UsageStore,
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

export interface FirestoreRecoveryEvent {
  type: 'reservation.recovered';
  timestamp: number;
  store: 'firestore';
  recovery: 'pending_released' | 'liable_retained';
  reservationId: string;
  reservedUnits: number;
  count: 1;
}

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
  tombstonesDeleted: number;
}

type ReservationState = 'pending' | 'liable' | 'settled';

interface StoredReservation {
  schemaVersion: 1;
  state: ReservationState;
  budgetIds: string[];
  reservedUnits: number;
  expiresAtMs: number;
  actualUnits?: number;
  outcomeHash?: string;
}

interface RecoveryResult {
  kind: 'none' | 'pending_released' | 'liable_retained' | 'tombstone_deleted';
  reservedUnits: number;
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
export class FirestoreUsageStore implements UsageStore {
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

    const transactionResult = await this.runTransaction<ReserveTransactionResult>(
      async transaction => {
        const existingSnapshot = await transaction.get(reservationRef);
        const existing = readReservation(existingSnapshot);
        const existingBudgetIds = existing?.budgetIds ?? [];
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
          reason: 'missing' | 'invalid_units' | 'conflict';
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
        schemaVersion: 1,
        state: 'settled',
        budgetIds: reservation.budgetIds,
        reservedUnits: reservation.reservedUnits,
        expiresAtMs: safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry'),
        actualUnits: input.actualUnits,
        outcomeHash,
      });

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
      tombstonesDeleted: 0,
    };

    for (const document of snapshot.docs) {
      const recovery = await this.recoverReservation(document.ref.id, now);
      if (recovery.kind === 'pending_released') {
        summary.pendingCount += 1;
        summary.pendingUnits += recovery.reservedUnits;
        this.emitRecovery(recovery, document.ref.id, now);
      } else if (recovery.kind === 'liable_retained') {
        summary.liableCount += 1;
        summary.liableUnits += recovery.reservedUnits;
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
    const usedById = await readBudgets(
      transaction,
      budgetCollection,
      reservation.budgetIds,
    );
    releaseAcrossBudgets(usedById, reservation.budgetIds, reservation.reservedUnits);
    writeUsedBudgets(
      transaction,
      budgetCollection,
      usedById,
      reservation.budgetIds,
      now,
    );
    transaction.delete(reservationRef);
    return {
      kind: 'pending_released',
      reservedUnits: reservation.reservedUnits,
    };
  }

  if (reservation.state === 'liable') {
    // Full reservation remains charged. No budget read/write is necessary.
    transaction.set(
      reservationRef,
      settledFromExpiredLiable(reservation, now, idempotencyTtlMs),
    );
    return {
      kind: 'liable_retained',
      reservedUnits: reservation.reservedUnits,
    };
  }

  // A settled tombstone no longer owns releasable capacity.
  transaction.delete(reservationRef);
  return { kind: 'tombstone_deleted', reservedUnits: 0 };
}

function recoverStoredReservation(
  reservation: StoredReservation,
  usedById: Map<string, number>,
): RecoveryResult {
  if (reservation.state === 'pending') {
    releaseAcrossBudgets(usedById, reservation.budgetIds, reservation.reservedUnits);
    return {
      kind: 'pending_released',
      reservedUnits: reservation.reservedUnits,
    };
  }
  if (reservation.state === 'liable') {
    return {
      kind: 'liable_retained',
      reservedUnits: reservation.reservedUnits,
    };
  }
  return { kind: 'tombstone_deleted', reservedUnits: 0 };
}

function settledFromExpiredLiable(
  reservation: StoredReservation,
  now: number,
  idempotencyTtlMs: number,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    state: 'settled',
    budgetIds: reservation.budgetIds,
    reservedUnits: reservation.reservedUnits,
    expiresAtMs: safeAdd(now, idempotencyTtlMs, 'tombstone expiry'),
    actualUnits: reservation.reservedUnits,
    outcomeHash: digest(EXPIRED_LIABLE_OUTCOME),
  };
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
  if (data.actualUnits !== undefined) {
    result.actualUnits = readSafeNonNegativeInteger(data.actualUnits, 'actualUnits');
  }
  if (data.outcomeHash !== undefined) {
    if (typeof data.outcomeHash !== 'string' || !HASH_PATTERN.test(data.outcomeHash)) {
      throw new UsageStateError('Firestore reservation document had an invalid outcome hash');
    }
    result.outcomeHash = data.outcomeHash;
  }
  if (state === 'settled' && (result.actualUnits === undefined || result.outcomeHash === undefined)) {
    throw new UsageStateError('Firestore settled reservation was incomplete');
  }
  return result;
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
