import { randomUUID } from 'node:crypto';
import {
  emitUsageEvent,
  usageErrorName,
  type UsageEventMetadata,
  type UsageObserver,
} from './observability.js';

export * from './observability.js';
export * from './weighted-credits.js';
export * from './windowed-budget-keys.js';

export interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}

export interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}

export interface Budget {
  key: string;
  limit: number;
}

export interface BudgetRemaining {
  key: string;
  remaining: number;
}

/** One metering dimension inside a single logical vector admission. */
export interface UsageDimension {
  key: string;
  units: number;
  budgets: readonly Budget[];
}

export interface UsageDimensionGrowth {
  key: string;
  additionalUnits: number;
  budgets: readonly Budget[];
}

export interface UsageDimensionActual {
  key: string;
  actualUnits: number;
}

export interface UsageDimensionReserved {
  key: string;
  reservedUnits: number;
}

/** Current balance for one budget, qualified by its vector dimension. */
export interface VectorBudgetRemaining {
  dimensionKey: string;
  budgetKey: string;
  remaining: number;
}

export interface VectorReservationDimension {
  key: string;
  budgetKeys: string[];
  reservedUnits: number;
}

export interface VectorReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  dimensions: VectorReservationDimension[];
  expiresAt: number;
  /** One opaque replay fence serializes growth across the whole vector. */
  growthCursor?: string;
}

export type VectorUsageQuote =
  | {
      decision: 'allow';
      dimensions: readonly UsageDimension[];
      reservationTtlMs?: number;
    }
  | { decision: 'deny'; reason: string };

export interface VectorUsagePolicy {
  quote(request: UsageRequest): VectorUsageQuote | Promise<VectorUsageQuote>;
}

type AllowUsageQuoteBase = {
  decision: 'allow';
  units: number;
  reservationTtlMs?: number;
};

/**
 * `budgets` is the v0.1 form. `budget` remains accepted as a source-compatibility
 * convenience for single-budget callers and is normalized to a one-element list.
 */
export type UsageQuote =
  | (AllowUsageQuoteBase & { budgets: readonly Budget[]; budget?: never })
  | (AllowUsageQuoteBase & { budget: Budget; budgets?: never })
  | { decision: 'deny'; reason: string };

export interface UsagePolicy {
  quote(request: UsageRequest): UsageQuote | Promise<UsageQuote>;
}

export interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  budgetKeys: string[];
  reservedUnits: number;
  expiresAt: number;
  /** Opaque replay fence present only on reservations created by growth-capable Stores. */
  growthCursor?: string;
}

export type StoreReserveResult =
  | {
      accepted: true;
      reservation: ReservationRecord;
      remainingByBudget: BudgetRemaining[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded' | 'duplicate_operation';
      limitingBudgetKey?: string;
      remaining?: number;
    };

export interface MarkLiableInput {
  reservationId: string;
}

export interface MarkLiableResult {
  reservationId: string;
  expiresAt: number;
}

export interface RenewInput {
  reservationId: string;
  ttlMs: number;
}

export interface RenewResult {
  reservationId: string;
  expiresAt: number;
}

export interface SettleInput {
  reservationId: string;
  actualUnits: number;
  outcome: string;
}

export interface SettlementResult {
  reservationId: string;
  reservedUnits: number;
  actualUnits: number;
  releasedUnits: number;
  outcome: string;
}

export interface UsageOperationReconciliationInput {
  /** The exact trusted logical operation identity of the scalar reservation being reconciled. */
  request: UsageRequest;
  /** The expected currently retained scalar reserved units. */
  units: number;
  /** Expected budget identities. Limits are current policy inputs, not historical retained state. */
  budgets: readonly Budget[];
}

/**
 * Read-only authoritative status for one retained scalar logical operation.
 *
 * `absent` means only that the Store has no retained state at lookup time. It is
 * not proof that the operation never existed once the Store's retention horizon
 * may have elapsed, so callers must not turn `absent` into an automatic replay.
 */
export type UsageOperationReconciliation =
  | { status: 'absent'; reservationId: string }
  | {
      status: 'active';
      state: 'pending' | 'liable';
      reservation: ReservationRecord;
    }
  | {
      status: 'expired';
      state: 'pending' | 'liable';
      reservationId: string;
      expiredAt: number;
    }
  | {
      status: 'settled';
      reservationId: string;
      reservedUnits: number;
      actualUnits: number;
      tombstoneExpiresAt: number;
    };

export interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult>;
  markLiable(input: MarkLiableInput): Promise<MarkLiableResult>;
  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}

/** Optional scalar-only read capability; it never admits, renews, releases, or settles usage. */
export interface OperationReconciliationStore extends UsageStore {
  reconcileOperation(
    input: UsageOperationReconciliationInput,
  ): Promise<UsageOperationReconciliation>;
}

export interface GrowReservationInput {
  reservationId: string;
  incrementId: string;
  expectedGrowthCursor: string;
  additionalUnits: number;
  budgets: readonly Budget[];
}

export type StoreGrowResult =
  | {
      accepted: true;
      replayed: boolean;
      reservationId: string;
      incrementId: string;
      previousReservedUnits: number;
      reservedUnits: number;
      growthCursor: string;
      remainingByBudget: BudgetRemaining[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded';
      replayed: boolean;
      reservationId: string;
      incrementId: string;
      growthCursor: string;
      limitingBudgetKey: string;
      remaining: number;
    };

/** Optional Store capability. Existing fixed-reservation UsageStore implementations remain valid. */
export interface ProgressiveUsageStore extends UsageStore {
  growReservation(input: GrowReservationInput): Promise<StoreGrowResult>;
}

export interface ReservationGrowthRequest {
  incrementId: string;
  additionalUnits: number;
  budgets: readonly Budget[];
}

export interface VectorReserveInput {
  request: UsageRequest;
  dimensions: readonly UsageDimension[];
  ttlMs: number;
}

export type StoreVectorReserveResult =
  | {
      accepted: true;
      reservation: VectorReservationRecord;
      remainingByBudget: VectorBudgetRemaining[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded' | 'duplicate_operation';
      limitingDimensionKey?: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };

export interface VectorGrowReservationInput {
  reservationId: string;
  incrementId: string;
  expectedGrowthCursor: string;
  dimensions: readonly UsageDimensionGrowth[];
}

export type StoreVectorGrowResult =
  | {
      accepted: true;
      replayed: boolean;
      reservationId: string;
      incrementId: string;
      previousReservedByDimension: UsageDimensionReserved[];
      reservedByDimension: UsageDimensionReserved[];
      growthCursor: string;
      remainingByBudget: VectorBudgetRemaining[];
    }
  | {
      accepted: false;
      reason: 'quota_exceeded';
      replayed: boolean;
      reservationId: string;
      incrementId: string;
      growthCursor: string;
      limitingDimensionKey: string;
      limitingBudgetKey: string;
      remaining: number;
    };

export interface VectorSettleInput {
  reservationId: string;
  actualByDimension: readonly UsageDimensionActual[];
  outcome: string;
}

export interface VectorSettlementDimension {
  key: string;
  reservedUnits: number;
  actualUnits: number;
  releasedUnits: number;
}

export interface VectorSettlementResult {
  reservationId: string;
  dimensions: VectorSettlementDimension[];
  outcome: string;
}

/**
 * Optional atomic vector capability. Scalar UsageStore methods remain unchanged.
 * Implementations must keep scalar and vector reservations in one operation-idempotency domain.
 */
export interface VectorUsageStore extends UsageStore {
  reserveVector(input: VectorReserveInput): Promise<StoreVectorReserveResult>;
  growVectorReservation(input: VectorGrowReservationInput): Promise<StoreVectorGrowResult>;
  settleVector(input: VectorSettleInput): Promise<VectorSettlementResult>;
}

export interface VectorReservationGrowthRequest {
  incrementId: string;
  dimensions: readonly UsageDimensionGrowth[];
}

export type VectorAdmissionResult =
  | {
      allowed: true;
      lease: VectorUsageLease;
      remainingByBudget: VectorBudgetRemaining[];
    }
  | {
      allowed: false;
      reason: string;
      limitingDimensionKey?: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };

export type AdmissionResult =
  | { allowed: true; lease: UsageLease; remainingByBudget: BudgetRemaining[] }
  | {
      allowed: false;
      reason: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };

export class UsageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageStateError';
  }
}

export class UsageDeniedError extends Error {
  constructor(public readonly reason: string) {
    super('Usage denied by usage policy');
    this.name = 'UsageDeniedError';
  }
}

export interface UsageControlOptions {
  defaultReservationTtlMs?: number;
  observer?: UsageObserver;
  /** Explicit metadata only. Request args are never copied into events automatically. */
  metadata?: UsageEventMetadata | ((request: UsageRequest) => UsageEventMetadata | undefined);
}

/**
 * Serializable server-side state required to reattach to an already-reserved lease.
 *
 * This state is trusted application data, not a client credential. Do not send it to
 * an untrusted client. Adapters that need a client round-trip should keep this state
 * server-side and expose only an integrity-protected opaque reference.
 */
export interface UsageLeaseResumeState {
  reservation: ReservationRecord;
  ttlMs: number;
  metadata?: UsageEventMetadata;
  /** Retained only after an ambiguous growth call so the same attempt must be retried. */
  unresolvedGrowth?: ReservationGrowthRequest;
}

export interface VectorUsageLeaseResumeState {
  reservation: VectorReservationRecord;
  ttlMs: number;
  metadata?: UsageEventMetadata;
  /** Retained only after an ambiguous vector growth call so exact retry is mandatory. */
  unresolvedGrowth?: VectorReservationGrowthRequest;
}

export class UsageLease {
  private unresolvedGrowth: ReservationGrowthRequest | undefined;

  constructor(
    private readonly store: UsageStore,
    public readonly reservation: ReservationRecord,
    public readonly ttlMs: number,
    private readonly observer?: UsageObserver,
    private readonly metadata?: UsageEventMetadata,
    unresolvedGrowth?: ReservationGrowthRequest,
  ) {
    this.unresolvedGrowth =
      unresolvedGrowth === undefined ? undefined : canonicalizeGrowthRequest(unresolvedGrowth);
  }

  get reservedUnits(): number {
    return this.reservation.reservedUnits;
  }

  /** Export a detached snapshot for trusted server-side suspend/resume workflows. */
  toResumeState(): UsageLeaseResumeState {
    return {
      reservation: cloneReservationRecord(this.reservation),
      ttlMs: this.ttlMs,
      ...(this.metadata === undefined ? {} : { metadata: { ...this.metadata } }),
      ...(this.unresolvedGrowth === undefined
        ? {}
        : { unresolvedGrowth: cloneGrowthRequest(this.unresolvedGrowth) }),
    };
  }

  /**
   * Increase capacity on the same logical reservation.
   *
   * A thrown Store/provider error is ambiguous. After one, this lease permits only an exact
   * retry of the same increment until an authoritative accepted/denied result is returned.
   */
  async grow(input: ReservationGrowthRequest): Promise<StoreGrowResult> {
    const request = canonicalizeGrowthRequest(input);
    if (this.unresolvedGrowth && !sameGrowthRequest(this.unresolvedGrowth, request)) {
      throw new UsageStateError(
        'A reservation growth attempt is unresolved; retry the same incrementId and parameters',
      );
    }
    if (!isProgressiveUsageStore(this.store)) {
      throw new UsageStateError('UsageStore does not support progressive reservation growth');
    }
    const expectedGrowthCursor = this.reservation.growthCursor;
    if (!expectedGrowthCursor) {
      throw new UsageStateError('Reservation was not created with progressive growth support');
    }

    this.unresolvedGrowth = request;
    try {
      const result = validateStoreGrowthResult(
        await this.store.growReservation({
          reservationId: this.reservation.id,
          incrementId: request.incrementId,
          expectedGrowthCursor,
          additionalUnits: request.additionalUnits,
          budgets: request.budgets,
        }),
        this.reservation,
        request,
      );
      this.reservation.growthCursor = result.growthCursor;
      if (result.accepted) this.reservation.reservedUnits = result.reservedUnits;
      this.unresolvedGrowth = undefined;
      return result;
    } catch (error) {
      if (error instanceof UsageStateError) {
        // Built-in Stores use UsageStateError only for authoritative state rejection.
        // Transport/provider ambiguity keeps the attempt pinned for exact retry.
        this.unresolvedGrowth = undefined;
      }
      throw error;
    }
  }

  async markLiable(): Promise<MarkLiableResult> {
    try {
      const marked = await this.store.markLiable({ reservationId: this.reservation.id });
      this.reservation.expiresAt = marked.expiresAt;
      return marked;
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'mark_liable',
        source: 'store',
        reservationId: this.reservation.id,
        ...reservationIdentity(this.reservation),
        errorName: usageErrorName(error),
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      throw error;
    }
  }

  async renew(ttlMs = this.ttlMs): Promise<RenewResult> {
    assertPositiveInteger(ttlMs, 'ttlMs');
    try {
      const renewed = await this.store.renew({ reservationId: this.reservation.id, ttlMs });
      this.reservation.expiresAt = renewed.expiresAt;
      return renewed;
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'renew',
        source: 'store',
        reservationId: this.reservation.id,
        ...reservationIdentity(this.reservation),
        errorName: usageErrorName(error),
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      throw error;
    }
  }

  async settle(actualUnits: number, outcome: string): Promise<SettlementResult> {
    try {
      const settlement = await this.store.settle({
        reservationId: this.reservation.id,
        actualUnits,
        outcome,
      });
      emitUsageEvent(this.observer, {
        type: 'settlement.completed',
        timestamp: Date.now(),
        reservationId: this.reservation.id,
        ...reservationIdentity(this.reservation),
        budgetKeys: [...this.reservation.budgetKeys],
        reservedUnits: settlement.reservedUnits,
        actualUnits: settlement.actualUnits,
        releasedUnits: settlement.releasedUnits,
        outcome: settlement.outcome,
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      return settlement;
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'settle',
        source: 'store',
        reservationId: this.reservation.id,
        ...reservationIdentity(this.reservation),
        errorName: usageErrorName(error),
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      throw error;
    }
  }
}

export class VectorUsageLease {
  private unresolvedGrowth: VectorReservationGrowthRequest | undefined;

  constructor(
    private readonly store: UsageStore,
    public readonly reservation: VectorReservationRecord,
    public readonly ttlMs: number,
    private readonly observer?: UsageObserver,
    private readonly metadata?: UsageEventMetadata,
    unresolvedGrowth?: VectorReservationGrowthRequest,
  ) {
    this.unresolvedGrowth =
      unresolvedGrowth === undefined
        ? undefined
        : canonicalizeVectorGrowthRequest(unresolvedGrowth);
  }

  get reservedByDimension(): UsageDimensionReserved[] {
    return this.reservation.dimensions.map(dimension => ({
      key: dimension.key,
      reservedUnits: dimension.reservedUnits,
    }));
  }

  toResumeState(): VectorUsageLeaseResumeState {
    return {
      reservation: cloneVectorReservationRecord(this.reservation),
      ttlMs: this.ttlMs,
      ...(this.metadata === undefined ? {} : { metadata: { ...this.metadata } }),
      ...(this.unresolvedGrowth === undefined
        ? {}
        : { unresolvedGrowth: cloneVectorGrowthRequest(this.unresolvedGrowth) }),
    };
  }

  async grow(input: VectorReservationGrowthRequest): Promise<StoreVectorGrowResult> {
    const request = canonicalizeVectorGrowthRequest(input);
    if (this.unresolvedGrowth && !sameVectorGrowthRequest(this.unresolvedGrowth, request)) {
      throw new UsageStateError(
        'A vector growth attempt is unresolved; retry the same incrementId and parameters',
      );
    }
    if (!isVectorUsageStore(this.store)) {
      throw new UsageStateError('UsageStore does not support atomic vector usage');
    }
    const expectedGrowthCursor = this.reservation.growthCursor;
    if (!expectedGrowthCursor) {
      throw new UsageStateError('Vector reservation was not created with growth support');
    }

    this.unresolvedGrowth = request;
    try {
      const result = validateStoreVectorGrowthResult(
        await this.store.growVectorReservation({
          reservationId: this.reservation.id,
          incrementId: request.incrementId,
          expectedGrowthCursor,
          dimensions: request.dimensions,
        }),
        this.reservation,
        request,
      );
      this.reservation.growthCursor = result.growthCursor;
      if (result.accepted) {
        const byKey = new Map(result.reservedByDimension.map(item => [item.key, item.reservedUnits]));
        for (const dimension of this.reservation.dimensions) {
          const reservedUnits = byKey.get(dimension.key);
          if (reservedUnits === undefined) {
            throw new UsageStateError('Vector growth result omitted a reservation dimension');
          }
          dimension.reservedUnits = reservedUnits;
        }
      }
      this.unresolvedGrowth = undefined;
      return result;
    } catch (error) {
      if (error instanceof UsageStateError) this.unresolvedGrowth = undefined;
      throw error;
    }
  }

  async markLiable(): Promise<MarkLiableResult> {
    try {
      const marked = await this.store.markLiable({ reservationId: this.reservation.id });
      this.reservation.expiresAt = marked.expiresAt;
      return marked;
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'mark_liable',
        source: 'store',
        reservationId: this.reservation.id,
        ...vectorReservationIdentity(this.reservation),
        errorName: usageErrorName(error),
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      throw error;
    }
  }

  async renew(ttlMs = this.ttlMs): Promise<RenewResult> {
    assertPositiveInteger(ttlMs, 'ttlMs');
    try {
      const renewed = await this.store.renew({ reservationId: this.reservation.id, ttlMs });
      this.reservation.expiresAt = renewed.expiresAt;
      return renewed;
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'renew',
        source: 'store',
        reservationId: this.reservation.id,
        ...vectorReservationIdentity(this.reservation),
        errorName: usageErrorName(error),
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      throw error;
    }
  }

  async settle(
    actualByDimension: readonly UsageDimensionActual[],
    outcome: string,
  ): Promise<VectorSettlementResult> {
    if (!isVectorUsageStore(this.store)) {
      throw new UsageStateError('UsageStore does not support atomic vector usage');
    }
    const actual = canonicalizeVectorActuals(actualByDimension, this.reservation.dimensions);
    try {
      const settlement = await this.store.settleVector({
        reservationId: this.reservation.id,
        actualByDimension: actual,
        outcome,
      });
      emitUsageEvent(this.observer, {
        type: 'vector.settlement.completed',
        timestamp: Date.now(),
        reservationId: this.reservation.id,
        ...vectorReservationIdentity(this.reservation),
        dimensions: settlement.dimensions.map(dimension => ({ ...dimension })),
        outcome: settlement.outcome,
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      return settlement;
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'settle',
        source: 'store',
        reservationId: this.reservation.id,
        ...vectorReservationIdentity(this.reservation),
        errorName: usageErrorName(error),
        ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      });
      throw error;
    }
  }
}

export class UsageControl {
  private readonly defaultReservationTtlMs: number;
  private readonly observer?: UsageObserver;
  private readonly metadata?: UsageControlOptions['metadata'];

  constructor(
    private readonly store: UsageStore,
    private readonly policy: UsagePolicy,
    optionsOrTtl: number | UsageControlOptions = 60_000,
  ) {
    if (typeof optionsOrTtl === 'number') {
      this.defaultReservationTtlMs = optionsOrTtl;
    } else {
      this.defaultReservationTtlMs = optionsOrTtl.defaultReservationTtlMs ?? 60_000;
      this.observer = optionsOrTtl.observer;
      this.metadata = optionsOrTtl.metadata;
    }
    assertPositiveInteger(this.defaultReservationTtlMs, 'defaultReservationTtlMs');
  }

  /**
   * Reattach to an existing reservation without calling policy.quote() or reserve().
   *
   * The caller must obtain `state` from a trusted server-side `UsageLease` snapshot.
   * The underlying store remains authoritative: the first renew/settle still fails
   * closed if the reservation expired, was settled, or otherwise conflicts.
   */
  resumeLease(state: UsageLeaseResumeState): UsageLease {
    assertPositiveInteger(state.ttlMs, 'ttlMs');
    const reservation = cloneReservationRecord(state.reservation);
    return new UsageLease(
      this.store,
      reservation,
      state.ttlMs,
      this.observer,
      state.metadata === undefined ? undefined : { ...state.metadata },
      state.unresolvedGrowth,
    );
  }

  async reserve<TArgs>(request: UsageRequest<TArgs>): Promise<AdmissionResult> {
    validateRequestIdentity(request);
    const requestForPolicy = request as UsageRequest;
    const metadata = resolveMetadata(this.metadata, requestForPolicy);
    let quote: NormalizedUsagePolicyQuote;
    try {
      quote = normalizeUsagePolicyQuote(await this.policy.quote(requestForPolicy));
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'quote',
        source: 'policy',
        ...requestIdentity(requestForPolicy),
        errorName: usageErrorName(error),
        ...(metadata === undefined ? {} : { metadata }),
      });
      throw error;
    }

    if (quote.decision === 'deny') {
      emitUsageEvent(this.observer, {
        type: 'reserve.denied',
        timestamp: Date.now(),
        ...requestIdentity(requestForPolicy),
        reason: quote.reason,
        ...(metadata === undefined ? {} : { metadata }),
      });
      return { allowed: false, reason: quote.reason };
    }

    const budgets = quote.budgets;
    const ttlMs = quote.reservationTtlMs ?? this.defaultReservationTtlMs;
    assertPositiveInteger(ttlMs, 'reservationTtlMs');

    let result: StoreReserveResult;
    try {
      result = validateStoreReserveResult(
        await this.store.reserve({
          request: requestForPolicy,
          units: quote.units,
          budgets,
          ttlMs,
        }),
        requestForPolicy,
        quote.units,
        budgets,
      );
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'reserve',
        source: 'store',
        ...requestIdentity(requestForPolicy),
        errorName: usageErrorName(error),
        ...(metadata === undefined ? {} : { metadata }),
      });
      throw error;
    }

    if (!result.accepted) {
      emitUsageEvent(this.observer, {
        type: 'reserve.denied',
        timestamp: Date.now(),
        ...requestIdentity(requestForPolicy),
        reason: result.reason,
        ...(result.limitingBudgetKey === undefined
          ? {}
          : { limitingBudgetKey: result.limitingBudgetKey }),
        ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
        ...(metadata === undefined ? {} : { metadata }),
      });
      return {
        allowed: false,
        reason: result.reason,
        ...(result.limitingBudgetKey === undefined
          ? {}
          : { limitingBudgetKey: result.limitingBudgetKey }),
        ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
      };
    }

    emitUsageEvent(this.observer, {
      type: 'reserve.accepted',
      timestamp: Date.now(),
      ...requestIdentity(requestForPolicy),
      reservationId: result.reservation.id,
      budgetKeys: [...result.reservation.budgetKeys],
      reservedUnits: result.reservation.reservedUnits,
      remainingByBudget: result.remainingByBudget.map(balance => ({ ...balance })),
      ...(metadata === undefined ? {} : { metadata }),
    });

    return {
      allowed: true,
      lease: new UsageLease(this.store, result.reservation, ttlMs, this.observer, metadata),
      remainingByBudget: result.remainingByBudget.map(balance => ({ ...balance })),
    };
  }
}

export class VectorUsageControl {
  private readonly defaultReservationTtlMs: number;
  private readonly observer?: UsageObserver;
  private readonly metadata?: UsageControlOptions['metadata'];

  constructor(
    private readonly store: UsageStore,
    private readonly policy: VectorUsagePolicy,
    optionsOrTtl: number | UsageControlOptions = 60_000,
  ) {
    if (typeof optionsOrTtl === 'number') {
      this.defaultReservationTtlMs = optionsOrTtl;
    } else {
      this.defaultReservationTtlMs = optionsOrTtl.defaultReservationTtlMs ?? 60_000;
      this.observer = optionsOrTtl.observer;
      this.metadata = optionsOrTtl.metadata;
    }
    assertPositiveInteger(this.defaultReservationTtlMs, 'defaultReservationTtlMs');
  }

  resumeLease(state: VectorUsageLeaseResumeState): VectorUsageLease {
    if (!isVectorUsageStore(this.store)) {
      throw new UsageStateError('UsageStore does not support atomic vector usage');
    }
    assertPositiveInteger(state.ttlMs, 'ttlMs');
    return new VectorUsageLease(
      this.store,
      cloneVectorReservationRecord(state.reservation),
      state.ttlMs,
      this.observer,
      state.metadata === undefined ? undefined : { ...state.metadata },
      state.unresolvedGrowth,
    );
  }

  async reserve<TArgs>(request: UsageRequest<TArgs>): Promise<VectorAdmissionResult> {
    validateRequestIdentity(request);
    if (!isVectorUsageStore(this.store)) {
      throw new UsageStateError('UsageStore does not support atomic vector usage');
    }
    const requestForPolicy = request as UsageRequest;
    const metadata = resolveMetadata(this.metadata, requestForPolicy);
    let quote: VectorUsageQuote;
    try {
      quote = normalizeVectorUsagePolicyQuote(await this.policy.quote(requestForPolicy));
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'quote',
        source: 'policy',
        ...requestIdentity(requestForPolicy),
        errorName: usageErrorName(error),
        ...(metadata === undefined ? {} : { metadata }),
      });
      throw error;
    }

    if (quote.decision === 'deny') {
      emitUsageEvent(this.observer, {
        type: 'vector.reserve.denied',
        timestamp: Date.now(),
        ...requestIdentity(requestForPolicy),
        reason: quote.reason,
        ...(metadata === undefined ? {} : { metadata }),
      });
      return { allowed: false, reason: quote.reason };
    }

    const dimensions = quote.dimensions;
    const ttlMs = quote.reservationTtlMs ?? this.defaultReservationTtlMs;
    assertPositiveInteger(ttlMs, 'reservationTtlMs');

    let result: StoreVectorReserveResult;
    try {
      result = validateStoreVectorReserveResult(
        await this.store.reserveVector({ request: requestForPolicy, dimensions, ttlMs }),
        requestForPolicy,
        dimensions,
      );
    } catch (error) {
      emitUsageEvent(this.observer, {
        type: 'operation.error',
        timestamp: Date.now(),
        phase: 'reserve',
        source: 'store',
        ...requestIdentity(requestForPolicy),
        errorName: usageErrorName(error),
        ...(metadata === undefined ? {} : { metadata }),
      });
      throw error;
    }

    if (!result.accepted) {
      emitUsageEvent(this.observer, {
        type: 'vector.reserve.denied',
        timestamp: Date.now(),
        ...requestIdentity(requestForPolicy),
        reason: result.reason,
        ...(result.limitingDimensionKey === undefined
          ? {}
          : { limitingDimensionKey: result.limitingDimensionKey }),
        ...(result.limitingBudgetKey === undefined
          ? {}
          : { limitingBudgetKey: result.limitingBudgetKey }),
        ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
        ...(metadata === undefined ? {} : { metadata }),
      });
      return {
        allowed: false,
        reason: result.reason,
        ...(result.limitingDimensionKey === undefined
          ? {}
          : { limitingDimensionKey: result.limitingDimensionKey }),
        ...(result.limitingBudgetKey === undefined
          ? {}
          : { limitingBudgetKey: result.limitingBudgetKey }),
        ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
      };
    }

    emitUsageEvent(this.observer, {
      type: 'vector.reserve.accepted',
      timestamp: Date.now(),
      ...requestIdentity(requestForPolicy),
      reservationId: result.reservation.id,
      dimensions: result.reservation.dimensions.map(dimension => ({
        key: dimension.key,
        reservedUnits: dimension.reservedUnits,
        budgetKeys: [...dimension.budgetKeys],
      })),
      remainingByBudget: result.remainingByBudget.map(balance => ({ ...balance })),
      ...(metadata === undefined ? {} : { metadata }),
    });

    return {
      allowed: true,
      lease: new VectorUsageLease(
        this.store,
        result.reservation,
        ttlMs,
        this.observer,
        metadata,
      ),
      remainingByBudget: result.remainingByBudget.map(balance => ({ ...balance })),
    };
  }
}

const DEFAULT_MEMORY_MAX_RETAINED_OPERATIONS = 100_000;
const DEFAULT_MEMORY_MAX_RETAINED_BUDGET_KEYS = 100_000;

export interface MemoryUsageStoreOptions {
  /** How long a settled operation remains replay-protected. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /**
   * Maximum active reservations plus settled replay tombstones retained in-process.
   * Defaults to 100,000. Capacity exhaustion fails closed instead of evicting state.
   */
  maxRetainedOperations?: number;
  /**
   * Maximum distinct budget keys with non-zero retained usage. Defaults to 100,000.
   * Capacity exhaustion fails closed instead of silently resetting a budget.
   */
  maxRetainedBudgetKeys?: number;
  /** Optional best-effort observer for expiry/recovery events. */
  observer?: UsageObserver;
}

export interface MemoryUsageStoreStats {
  retainedOperations: number;
  retainedBudgetKeys: number;
  maxRetainedOperations: number;
  maxRetainedBudgetKeys: number;
}

export class MemoryUsageStoreCapacityError extends UsageStateError {
  constructor(
    public readonly resource: 'operations' | 'budget_keys',
    public readonly limit: number,
  ) {
    super(
      resource === 'operations'
        ? `MemoryUsageStore operation retention limit reached (${limit}); refusing to evict replay/accounting state`
        : `MemoryUsageStore budget-key retention limit reached (${limit}); refusing to evict authoritative usage state`,
    );
    this.name = 'MemoryUsageStoreCapacityError';
  }
}

interface InternalReservationBase {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  expiresAt: number;
  growthCursor?: string;
  operationKey: string;
  state: 'pending' | 'liable' | 'settled';
  outcome?: string;
  tombstoneExpiresAt?: number;
}

interface InternalScalarReservation extends InternalReservationBase, ReservationRecord {
  mode: 'scalar';
  actualUnits?: number;
  lastGrowth?: {
    incrementId: string;
    expectedGrowthCursor: string;
    fingerprint: string;
    result: StoreGrowResult;
  };
}

interface InternalVectorReservation extends InternalReservationBase, VectorReservationRecord {
  mode: 'vector';
  actualByDimension?: UsageDimensionActual[];
  lastVectorGrowth?: {
    incrementId: string;
    expectedGrowthCursor: string;
    fingerprint: string;
    result: StoreVectorGrowResult;
  };
}

type InternalReservation = InternalScalarReservation | InternalVectorReservation;

export class MemoryUsageStore implements ProgressiveUsageStore, VectorUsageStore, OperationReconciliationStore {
  private readonly used = new Map<string, number>();
  private readonly reservations = new Map<string, InternalReservation>();
  private readonly operations = new Map<string, string>();
  private readonly idempotencyTtlMs: number;
  private readonly maxRetainedOperations: number;
  private readonly maxRetainedBudgetKeys: number;
  private readonly observer?: UsageObserver;
  private nextRecoveryAt = Number.POSITIVE_INFINITY;

  constructor(options: MemoryUsageStoreOptions = {}) {
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
    this.maxRetainedOperations =
      options.maxRetainedOperations ?? DEFAULT_MEMORY_MAX_RETAINED_OPERATIONS;
    this.maxRetainedBudgetKeys =
      options.maxRetainedBudgetKeys ?? DEFAULT_MEMORY_MAX_RETAINED_BUDGET_KEYS;
    this.observer = options.observer;
    assertPositiveInteger(this.idempotencyTtlMs, 'idempotencyTtlMs');
    assertPositiveInteger(this.maxRetainedOperations, 'maxRetainedOperations');
    assertPositiveInteger(this.maxRetainedBudgetKeys, 'maxRetainedBudgetKeys');
  }

  /** Current bounded-retention counters for health checks and operational monitoring. */
  stats(): MemoryUsageStoreStats {
    this.recoverExpired(Date.now());
    return {
      retainedOperations: this.reservations.size,
      retainedBudgetKeys: this.used.size,
      maxRetainedOperations: this.maxRetainedOperations,
      maxRetainedBudgetKeys: this.maxRetainedBudgetKeys,
    };
  }

  /**
   * Explicitly retire one budget key after its accounting window is permanently over.
   *
   * This is never automatic because forgetting non-zero usage can reset quota semantics.
   * Active reservations block retirement. Callers must ensure the same key will not later
   * be reused for the same accounting window.
   */
  retireBudgetKey(budgetKey: string): boolean {
    if (typeof budgetKey !== 'string' || budgetKey.length === 0) {
      throw new RangeError('budgetKey must be a non-empty string');
    }
    this.recoverExpired(Date.now());
    for (const reservation of this.reservations.values()) {
      if (
        reservation.state !== 'settled' &&
        internalReservationBudgetKeys(reservation).includes(budgetKey)
      ) {
        throw new UsageStateError('Cannot retire a budget key referenced by an active reservation');
      }
    }
    return this.used.delete(budgetKey);
  }

  async reconcileOperation(
    input: UsageOperationReconciliationInput,
  ): Promise<UsageOperationReconciliation> {
    assertNonNegativeInteger(input.units, 'units');
    const budgets = canonicalizeBudgets(input.budgets);
    validateRequestIdentity(input.request);

    const now = Date.now();
    const reservationId = operationKeyFor(input.request);
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return { status: 'absent', reservationId };
    if (reservation.mode !== 'scalar') {
      throw new UsageStateError('Scalar operation reconciliation cannot target a vector reservation');
    }
    if (
      reservation.reservedUnits !== input.units ||
      !sameBudgetKeys(reservation.budgetKeys, budgets)
    ) {
      throw new UsageStateError('Operation reconciliation input does not match retained reservation state');
    }

    if (reservation.state === 'pending' || reservation.state === 'liable') {
      if (reservation.expiresAt <= now) {
        return {
          status: 'expired',
          state: reservation.state,
          reservationId: reservation.id,
          expiredAt: reservation.expiresAt,
        };
      }
      return {
        status: 'active',
        state: reservation.state,
        reservation: cloneReservationRecord(reservation),
      };
    }

    if (
      reservation.tombstoneExpiresAt !== undefined &&
      reservation.tombstoneExpiresAt <= now
    ) {
      return { status: 'absent', reservationId };
    }
    if (reservation.outcome === 'lease_expired_after_execution_started') {
      return {
        status: 'expired',
        state: 'liable',
        reservationId: reservation.id,
        expiredAt: reservation.expiresAt,
      };
    }
    if (reservation.actualUnits === undefined || reservation.tombstoneExpiresAt === undefined) {
      throw new UsageStateError('Settled reservation is missing reconciliation state');
    }
    return {
      status: 'settled',
      reservationId: reservation.id,
      reservedUnits: reservation.reservedUnits,
      actualUnits: reservation.actualUnits,
      tombstoneExpiresAt: reservation.tombstoneExpiresAt,
    };
  }

  async reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    assertNonNegativeInteger(input.units, 'units');
    const budgets = canonicalizeBudgets(input.budgets);
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    validateRequestIdentity(input.request);

    const now = Date.now();
    const expiresAt = safeAdd(now, input.ttlMs, 'reservation expiry');
    this.recoverExpired(now);

    const operationKey = operationKeyFor(input.request);
    if (this.operations.has(operationKey)) {
      return { accepted: false, reason: 'duplicate_operation' };
    }

    const remainingByBudget = budgets.map(budget => ({
      key: budget.key,
      remaining: Math.max(0, budget.limit - (this.used.get(budget.key) ?? 0)),
    }));
    const limiting = remainingByBudget.find(balance => input.units > balance.remaining);
    if (limiting) {
      return {
        accepted: false,
        reason: 'quota_exceeded',
        limitingBudgetKey: limiting.key,
        remaining: limiting.remaining,
      };
    }

    this.assertOperationCapacity();
    if (input.units > 0) this.assertBudgetCapacity(budgets);

    const reservation: InternalScalarReservation = {
      mode: 'scalar',
      id: operationKey,
      operationId: input.request.operationId,
      principalId: input.request.principal.id,
      ...(input.request.principal.tenantId === undefined
        ? {}
        : { tenantId: input.request.principal.tenantId }),
      ...(input.request.principal.plan === undefined ? {} : { plan: input.request.principal.plan }),
      tool: input.request.tool,
      budgetKeys: budgets.map(budget => budget.key),
      reservedUnits: input.units,
      expiresAt,
      growthCursor: newGrowthCursor(),
      operationKey,
      state: 'pending',
    };

    if (input.units > 0) {
      for (const budget of budgets) {
        this.used.set(budget.key, (this.used.get(budget.key) ?? 0) + input.units);
      }
    }
    this.reservations.set(reservation.id, reservation);
    this.operations.set(operationKey, reservation.id);
    this.trackRecoveryAt(reservation.expiresAt);

    return {
      accepted: true,
      reservation: cloneReservationRecord(reservation),
      remainingByBudget: remainingByBudget.map(balance => ({
        key: balance.key,
        remaining: balance.remaining - input.units,
      })),
    };
  }

  async reserveVector(input: VectorReserveInput): Promise<StoreVectorReserveResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    validateRequestIdentity(input.request);
    const dimensions = canonicalizeUsageDimensions(input.dimensions);
    const now = Date.now();
    const expiresAt = safeAdd(now, input.ttlMs, 'reservation expiry');
    this.recoverExpired(now);

    const operationKey = operationKeyFor(input.request);
    if (this.operations.has(operationKey)) {
      return { accepted: false, reason: 'duplicate_operation' };
    }

    const remainingByBudget: VectorBudgetRemaining[] = [];
    let limiting:
      | { dimensionKey: string; budgetKey: string; remaining: number }
      | undefined;
    for (const dimension of dimensions) {
      for (const budget of dimension.budgets) {
        const remaining = Math.max(0, budget.limit - (this.used.get(budget.key) ?? 0));
        remainingByBudget.push({
          dimensionKey: dimension.key,
          budgetKey: budget.key,
          remaining,
        });
        if (!limiting && dimension.units > remaining) {
          limiting = { dimensionKey: dimension.key, budgetKey: budget.key, remaining };
        }
      }
    }
    if (limiting) {
      return {
        accepted: false,
        reason: 'quota_exceeded',
        limitingDimensionKey: limiting.dimensionKey,
        limitingBudgetKey: limiting.budgetKey,
        remaining: limiting.remaining,
      };
    }

    this.assertOperationCapacity();
    const nonZeroBudgets = dimensions.flatMap(dimension =>
      dimension.units > 0 ? dimension.budgets : [],
    );
    if (nonZeroBudgets.length > 0) this.assertBudgetCapacity(nonZeroBudgets);

    const reservation: InternalVectorReservation = {
      mode: 'vector',
      id: operationKey,
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
      growthCursor: newGrowthCursor(),
      operationKey,
      state: 'pending',
    };

    for (const dimension of dimensions) {
      if (dimension.units === 0) continue;
      for (const budget of dimension.budgets) {
        this.used.set(
          budget.key,
          safeAdd(this.used.get(budget.key) ?? 0, dimension.units, `usage (${budget.key})`),
        );
      }
    }
    this.reservations.set(reservation.id, reservation);
    this.operations.set(operationKey, reservation.id);
    this.trackRecoveryAt(reservation.expiresAt);

    const unitsByDimension = new Map(dimensions.map(dimension => [dimension.key, dimension.units]));
    return {
      accepted: true,
      reservation: cloneVectorReservationRecord(reservation),
      remainingByBudget: remainingByBudget.map(balance => ({
        ...balance,
        remaining: balance.remaining - (unitsByDimension.get(balance.dimensionKey) ?? 0),
      })),
    };
  }

  async growVectorReservation(
    input: VectorGrowReservationInput,
  ): Promise<StoreVectorGrowResult> {
    validateVectorGrowthInput(input);
    const dimensions = canonicalizeVectorGrowthDimensions(input.dimensions);
    const fingerprint = vectorGrowthFingerprint(dimensions);
    const now = Date.now();
    this.recoverExpired(now);

    const reservation = this.reservations.get(input.reservationId);
    if (!reservation) throw new UsageStateError('Reservation not found or expired');
    if (reservation.mode !== 'vector') {
      throw new UsageStateError('Vector growth cannot target a scalar reservation');
    }
    if (reservation.state === 'settled') {
      throw new UsageStateError('Cannot grow a settled or expired vector reservation');
    }

    const lastGrowth = reservation.lastVectorGrowth;
    if (lastGrowth?.incrementId === input.incrementId) {
      if (
        lastGrowth.expectedGrowthCursor !== input.expectedGrowthCursor ||
        lastGrowth.fingerprint !== fingerprint
      ) {
        throw new UsageStateError(
          'Vector growth increment was already attempted with different parameters',
        );
      }
      return replayVectorGrowthResult(lastGrowth.result);
    }

    if (!reservation.growthCursor) {
      throw new UsageStateError('Vector reservation does not support progressive growth');
    }
    if (reservation.growthCursor !== input.expectedGrowthCursor) {
      throw new UsageStateError('Vector growth cursor is stale or conflicts with reservation state');
    }
    if (!sameVectorTopology(reservation.dimensions, dimensions)) {
      throw new UsageStateError('Vector growth dimensions and budgets must match the reservation');
    }

    const remainingByBudget: VectorBudgetRemaining[] = [];
    let limiting:
      | { dimensionKey: string; budgetKey: string; remaining: number }
      | undefined;
    for (const dimension of dimensions) {
      for (const budget of dimension.budgets) {
        const remaining = Math.max(0, budget.limit - (this.used.get(budget.key) ?? 0));
        remainingByBudget.push({
          dimensionKey: dimension.key,
          budgetKey: budget.key,
          remaining,
        });
        if (!limiting && dimension.additionalUnits > remaining) {
          limiting = { dimensionKey: dimension.key, budgetKey: budget.key, remaining };
        }
      }
    }

    const nextGrowthCursor = newGrowthCursor();
    if (limiting) {
      const result: StoreVectorGrowResult = {
        accepted: false,
        reason: 'quota_exceeded',
        replayed: false,
        reservationId: reservation.id,
        incrementId: input.incrementId,
        growthCursor: nextGrowthCursor,
        limitingDimensionKey: limiting.dimensionKey,
        limitingBudgetKey: limiting.budgetKey,
        remaining: limiting.remaining,
      };
      reservation.growthCursor = nextGrowthCursor;
      reservation.lastVectorGrowth = {
        incrementId: input.incrementId,
        expectedGrowthCursor: input.expectedGrowthCursor,
        fingerprint,
        result: cloneVectorGrowthResult(result),
      };
      return result;
    }

    const newlyNonZeroBudgets = dimensions.flatMap(dimension =>
      dimension.additionalUnits > 0 ? dimension.budgets : [],
    );
    if (newlyNonZeroBudgets.length > 0) this.assertBudgetCapacity(newlyNonZeroBudgets);

    const previousReservedByDimension = reservation.dimensions.map(dimension => ({
      key: dimension.key,
      reservedUnits: dimension.reservedUnits,
    }));
    const growthByKey = new Map(dimensions.map(dimension => [dimension.key, dimension]));
    for (const reservedDimension of reservation.dimensions) {
      const growth = growthByKey.get(reservedDimension.key)!;
      if (growth.additionalUnits > 0) {
        for (const budget of growth.budgets) {
          this.used.set(
            budget.key,
            safeAdd(
              this.used.get(budget.key) ?? 0,
              growth.additionalUnits,
              `usage (${budget.key})`,
            ),
          );
        }
      }
      reservedDimension.reservedUnits = safeAdd(
        reservedDimension.reservedUnits,
        growth.additionalUnits,
        `reservedUnits (${reservedDimension.key})`,
      );
    }
    reservation.growthCursor = nextGrowthCursor;
    const reservedByDimension = reservation.dimensions.map(dimension => ({
      key: dimension.key,
      reservedUnits: dimension.reservedUnits,
    }));
    const addedByDimension = new Map(
      dimensions.map(dimension => [dimension.key, dimension.additionalUnits]),
    );
    const result: StoreVectorGrowResult = {
      accepted: true,
      replayed: false,
      reservationId: reservation.id,
      incrementId: input.incrementId,
      previousReservedByDimension,
      reservedByDimension,
      growthCursor: nextGrowthCursor,
      remainingByBudget: remainingByBudget.map(balance => ({
        ...balance,
        remaining: balance.remaining - (addedByDimension.get(balance.dimensionKey) ?? 0),
      })),
    };
    reservation.lastVectorGrowth = {
      incrementId: input.incrementId,
      expectedGrowthCursor: input.expectedGrowthCursor,
      fingerprint,
      result: cloneVectorGrowthResult(result),
    };
    return result;
  }

  async settleVector(input: VectorSettleInput): Promise<VectorSettlementResult> {
    const now = Date.now();
    const tombstoneExpiresAt = safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry');
    this.recoverExpired(now);
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation) throw new UsageStateError('Reservation not found or expired');
    if (reservation.mode !== 'vector') {
      throw new UsageStateError('Vector settlement cannot target a scalar reservation');
    }
    const actualByDimension = canonicalizeVectorActuals(input.actualByDimension, reservation.dimensions);

    if (reservation.state === 'settled') {
      if (
        reservation.outcome !== input.outcome ||
        !sameVectorActuals(reservation.actualByDimension, actualByDimension)
      ) {
        throw new UsageStateError('Vector reservation was already settled with a different result');
      }
      return toVectorSettlement(reservation);
    }

    const actualByKey = new Map(actualByDimension.map(item => [item.key, item.actualUnits]));
    for (const dimension of reservation.dimensions) {
      const actualUnits = actualByKey.get(dimension.key)!;
      const releasedUnits = dimension.reservedUnits - actualUnits;
      if (releasedUnits > 0) this.releaseAcrossBudgets(dimension.budgetKeys, releasedUnits);
    }
    reservation.state = 'settled';
    reservation.actualByDimension = actualByDimension.map(item => ({ ...item }));
    reservation.outcome = input.outcome;
    reservation.tombstoneExpiresAt = tombstoneExpiresAt;
    this.trackRecoveryAt(tombstoneExpiresAt);
    return toVectorSettlement(reservation);
  }

  async markLiable(input: MarkLiableInput): Promise<MarkLiableResult> {
    const now = Date.now();
    this.recoverExpired(now);
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.state === 'settled') {
      throw new UsageStateError('Active reservation not found or expired');
    }
    reservation.state = 'liable';
    return { reservationId: reservation.id, expiresAt: reservation.expiresAt };
  }

  async growReservation(input: GrowReservationInput): Promise<StoreGrowResult> {
    validateGrowthInput(input);
    const budgets = canonicalizeBudgets(input.budgets);
    const fingerprint = growthFingerprint(input.additionalUnits, budgets);
    const now = Date.now();
    this.recoverExpired(now);

    const reservation = this.reservations.get(input.reservationId);
    if (!reservation) throw new UsageStateError('Reservation not found or expired');
    if (reservation.mode !== 'scalar') {
      throw new UsageStateError('Scalar growth cannot target a vector reservation');
    }

    if (reservation.state === 'settled') {
      throw new UsageStateError('Cannot grow a settled or expired reservation');
    }

    const lastGrowth = reservation.lastGrowth;
    if (lastGrowth?.incrementId === input.incrementId) {
      if (
        lastGrowth.expectedGrowthCursor !== input.expectedGrowthCursor ||
        lastGrowth.fingerprint !== fingerprint
      ) {
        throw new UsageStateError('Growth increment was already attempted with different parameters');
      }
      return replayGrowthResult(lastGrowth.result);
    }

    if (!reservation.growthCursor) {
      throw new UsageStateError('Reservation does not support progressive growth');
    }
    if (reservation.growthCursor !== input.expectedGrowthCursor) {
      throw new UsageStateError('Growth cursor is stale or conflicts with reservation state');
    }
    if (!sameBudgetKeys(reservation.budgetKeys, budgets)) {
      throw new UsageStateError('Growth budgets must exactly match the reservation budget set');
    }

    const remainingByBudget = budgets.map(budget => ({
      key: budget.key,
      remaining: Math.max(0, budget.limit - (this.used.get(budget.key) ?? 0)),
    }));
    const limiting = remainingByBudget.find(
      balance => input.additionalUnits > balance.remaining,
    );
    const nextGrowthCursor = newGrowthCursor();

    if (limiting) {
      const result: StoreGrowResult = {
        accepted: false,
        reason: 'quota_exceeded',
        replayed: false,
        reservationId: reservation.id,
        incrementId: input.incrementId,
        growthCursor: nextGrowthCursor,
        limitingBudgetKey: limiting.key,
        remaining: limiting.remaining,
      };
      reservation.growthCursor = nextGrowthCursor;
      reservation.lastGrowth = {
        incrementId: input.incrementId,
        expectedGrowthCursor: input.expectedGrowthCursor,
        fingerprint,
        result: cloneGrowthResult(result),
      };
      return result;
    }

    this.assertBudgetCapacity(budgets);

    const previousReservedUnits = reservation.reservedUnits;
    const reservedUnits = safeAdd(
      previousReservedUnits,
      input.additionalUnits,
      'reservedUnits',
    );
    for (const budget of budgets) {
      this.used.set(
        budget.key,
        safeAdd(
          this.used.get(budget.key) ?? 0,
          input.additionalUnits,
          `usage (${budget.key})`,
        ),
      );
    }
    reservation.reservedUnits = reservedUnits;
    reservation.growthCursor = nextGrowthCursor;
    const result: StoreGrowResult = {
      accepted: true,
      replayed: false,
      reservationId: reservation.id,
      incrementId: input.incrementId,
      previousReservedUnits,
      reservedUnits,
      growthCursor: nextGrowthCursor,
      remainingByBudget: remainingByBudget.map(balance => ({
        key: balance.key,
        remaining: balance.remaining - input.additionalUnits,
      })),
    };
    reservation.lastGrowth = {
      incrementId: input.incrementId,
      expectedGrowthCursor: input.expectedGrowthCursor,
      fingerprint,
      result: cloneGrowthResult(result),
    };
    return result;
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const now = Date.now();
    const expiresAt = safeAdd(now, input.ttlMs, 'reservation expiry');
    this.recoverExpired(now);

    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.state === 'settled') {
      throw new UsageStateError('Active reservation not found or expired');
    }

    reservation.expiresAt = expiresAt;
    this.trackRecoveryAt(expiresAt);
    return { reservationId: reservation.id, expiresAt };
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    const now = Date.now();
    const tombstoneExpiresAt = safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry');
    this.recoverExpired(now);
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation) throw new UsageStateError('Reservation not found or expired');
    if (reservation.mode !== 'scalar') {
      throw new UsageStateError('Scalar settlement cannot target a vector reservation');
    }

    if (input.actualUnits > reservation.reservedUnits) {
      throw new UsageStateError('actualUnits cannot exceed reservedUnits');
    }

    if (reservation.state === 'settled') {
      if (reservation.actualUnits !== input.actualUnits || reservation.outcome !== input.outcome) {
        throw new UsageStateError('Reservation was already settled with a different result');
      }
      return toSettlement(reservation);
    }

    const released = reservation.reservedUnits - input.actualUnits;
    if (released > 0) this.releaseAcrossBudgets(reservation.budgetKeys, released);
    reservation.state = 'settled';
    reservation.actualUnits = input.actualUnits;
    reservation.outcome = input.outcome;
    reservation.tombstoneExpiresAt = tombstoneExpiresAt;
    this.trackRecoveryAt(tombstoneExpiresAt);
    return toSettlement(reservation);
  }

  private recoverExpired(now: number): void {
    if (now < this.nextRecoveryAt) return;

    // Preflight every liable transition before mutating any authoritative state.
    // This keeps recovery atomic with respect to unsafe tombstone arithmetic.
    for (const reservation of this.reservations.values()) {
      if (
        reservation.state === 'liable' &&
        reservation.expiresAt <= now
      ) {
        safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry');
      }
    }

    let nextRecoveryAt = Number.POSITIVE_INFINITY;
    for (const [id, reservation] of this.reservations) {
      if (reservation.state === 'settled') {
        const tombstoneExpiresAt = reservation.tombstoneExpiresAt ?? Number.POSITIVE_INFINITY;
        if (tombstoneExpiresAt <= now) {
          this.operations.delete(reservation.operationKey);
          this.reservations.delete(id);
        } else {
          nextRecoveryAt = Math.min(nextRecoveryAt, tombstoneExpiresAt);
        }
        continue;
      }
      if (reservation.expiresAt > now) {
        nextRecoveryAt = Math.min(nextRecoveryAt, reservation.expiresAt);
        continue;
      }

      if (reservation.state === 'pending') {
        if (reservation.mode === 'scalar') {
          this.releaseAcrossBudgets(reservation.budgetKeys, reservation.reservedUnits);
          emitUsageEvent(this.observer, {
            type: 'reservation.recovered',
            timestamp: now,
            store: 'memory',
            recovery: 'pending_released',
            reservationId: reservation.id,
            principalId: reservation.principalId,
            ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
            tool: reservation.tool,
            budgetIdentifiers: [...reservation.budgetKeys],
            reservedUnits: reservation.reservedUnits,
            count: 1,
          });
        } else {
          for (const dimension of reservation.dimensions) {
            this.releaseAcrossBudgets(dimension.budgetKeys, dimension.reservedUnits);
          }
          emitUsageEvent(this.observer, {
            type: 'vector.reservation.recovered',
            timestamp: now,
            store: 'memory',
            recovery: 'pending_released',
            reservationId: reservation.id,
            principalId: reservation.principalId,
            ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
            tool: reservation.tool,
            dimensionCount: reservation.dimensions.length,
            budgetCount: internalReservationBudgetKeys(reservation).length,
            count: 1,
          });
        }
        this.operations.delete(reservation.operationKey);
        this.reservations.delete(id);
        continue;
      }

      // Once execution has been marked liable, expiry is conservative: retain
      // the full reservation as consumed so a process crash cannot become a refund.
      reservation.state = 'settled';
      reservation.outcome = 'lease_expired_after_execution_started';
      reservation.tombstoneExpiresAt = safeAdd(now, this.idempotencyTtlMs, 'tombstone expiry');
      nextRecoveryAt = Math.min(nextRecoveryAt, reservation.tombstoneExpiresAt);
      if (reservation.mode === 'scalar') {
        reservation.actualUnits = reservation.reservedUnits;
        emitUsageEvent(this.observer, {
          type: 'reservation.recovered',
          timestamp: now,
          store: 'memory',
          recovery: 'liable_retained',
          reservationId: reservation.id,
          principalId: reservation.principalId,
          ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
          tool: reservation.tool,
          budgetIdentifiers: [...reservation.budgetKeys],
          reservedUnits: reservation.reservedUnits,
          count: 1,
        });
      } else {
        reservation.actualByDimension = reservation.dimensions.map(dimension => ({
          key: dimension.key,
          actualUnits: dimension.reservedUnits,
        }));
        emitUsageEvent(this.observer, {
          type: 'vector.reservation.recovered',
          timestamp: now,
          store: 'memory',
          recovery: 'liable_retained',
          reservationId: reservation.id,
          principalId: reservation.principalId,
          ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
          tool: reservation.tool,
          dimensionCount: reservation.dimensions.length,
          budgetCount: internalReservationBudgetKeys(reservation).length,
          count: 1,
        });
      }
    }
    this.nextRecoveryAt = nextRecoveryAt;
  }

  private assertOperationCapacity(): void {
    if (this.reservations.size >= this.maxRetainedOperations) {
      throw new MemoryUsageStoreCapacityError('operations', this.maxRetainedOperations);
    }
  }

  private assertBudgetCapacity(budgets: readonly Budget[]): void {
    const newBudgetKeys = new Set<string>();
    for (const budget of budgets) {
      if (!this.used.has(budget.key)) newBudgetKeys.add(budget.key);
    }
    if (this.used.size + newBudgetKeys.size > this.maxRetainedBudgetKeys) {
      throw new MemoryUsageStoreCapacityError('budget_keys', this.maxRetainedBudgetKeys);
    }
  }

  private trackRecoveryAt(expiresAt: number): void {
    this.nextRecoveryAt = Math.min(this.nextRecoveryAt, expiresAt);
  }

  private releaseAcrossBudgets(budgetKeys: readonly string[], units: number): void {
    for (const budgetKey of budgetKeys) {
      const next = Math.max(0, (this.used.get(budgetKey) ?? 0) - units);
      if (next === 0) this.used.delete(budgetKey);
      else this.used.set(budgetKey, next);
    }
  }
}

function internalReservationBudgetKeys(reservation: InternalReservation): string[] {
  return reservation.mode === 'scalar'
    ? [...reservation.budgetKeys]
    : reservation.dimensions.flatMap(dimension => [...dimension.budgetKeys]);
}

function validateVectorGrowthInput(input: VectorGrowReservationInput): void {
  if (typeof input.reservationId !== 'string' || input.reservationId.length === 0) {
    throw new RangeError('reservationId must be a non-empty string');
  }
  if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
    throw new RangeError('incrementId must be a non-empty string');
  }
  if (typeof input.expectedGrowthCursor !== 'string' || input.expectedGrowthCursor.length === 0) {
    throw new RangeError('expectedGrowthCursor must be a non-empty string');
  }
}

function sameVectorTopology(
  reserved: readonly VectorReservationDimension[],
  growth: readonly UsageDimensionGrowth[],
): boolean {
  if (reserved.length !== growth.length) return false;
  return reserved.every((dimension, index) => {
    const candidate = growth[index];
    return (
      candidate !== undefined &&
      dimension.key === candidate.key &&
      sameBudgetKeys(dimension.budgetKeys, candidate.budgets)
    );
  });
}

function cloneVectorGrowthResult(result: StoreVectorGrowResult): StoreVectorGrowResult {
  if (!result.accepted) return { ...result };
  return {
    ...result,
    previousReservedByDimension: result.previousReservedByDimension.map(item => ({ ...item })),
    reservedByDimension: result.reservedByDimension.map(item => ({ ...item })),
    remainingByBudget: result.remainingByBudget.map(item => ({ ...item })),
  };
}

function replayVectorGrowthResult(result: StoreVectorGrowResult): StoreVectorGrowResult {
  return { ...cloneVectorGrowthResult(result), replayed: true };
}

function sameVectorActuals(
  left: readonly UsageDimensionActual[] | undefined,
  right: readonly UsageDimensionActual[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.key === right[index]!.key && item.actualUnits === right[index]!.actualUnits,
    )
  );
}

function toVectorSettlement(reservation: InternalVectorReservation): VectorSettlementResult {
  const actual =
    reservation.actualByDimension ??
    reservation.dimensions.map(dimension => ({
      key: dimension.key,
      actualUnits: dimension.reservedUnits,
    }));
  const actualByKey = new Map(actual.map(item => [item.key, item.actualUnits]));
  return {
    reservationId: reservation.id,
    dimensions: reservation.dimensions.map(dimension => {
      const actualUnits = actualByKey.get(dimension.key) ?? dimension.reservedUnits;
      return {
        key: dimension.key,
        reservedUnits: dimension.reservedUnits,
        actualUnits,
        releasedUnits: dimension.reservedUnits - actualUnits,
      };
    }),
    outcome: reservation.outcome ?? 'unknown',
  };
}

function operationKeyFor(request: UsageRequest): string {
  return JSON.stringify([
    request.principal.tenantId ?? null,
    request.principal.id,
    request.tool,
    request.operationId,
  ]);
}

const MAX_POLICY_DENIAL_REASON_LENGTH = 128;

type NormalizedUsagePolicyQuote =
  | {
      decision: 'allow';
      units: number;
      budgets: Budget[];
      reservationTtlMs?: number;
    }
  | { decision: 'deny'; reason: string };

function normalizeUsagePolicyQuote(value: unknown): NormalizedUsagePolicyQuote {
  const quote = requireRecord(value, 'Usage policy quote');
  if (quote.decision === 'deny') {
    return { decision: 'deny', reason: validatePolicyDenialReason(quote.reason) };
  }
  if (quote.decision !== 'allow') {
    throw new TypeError('Usage policy quote decision must be allow or deny');
  }

  assertNonNegativeInteger(quote.units as number, 'units');
  const hasBudget = hasOwn(quote, 'budget');
  const hasBudgets = hasOwn(quote, 'budgets');
  if (hasBudget === hasBudgets) {
    throw new TypeError('Usage policy allow quote must contain exactly one of budget or budgets');
  }
  const budgets = hasBudgets
    ? canonicalizeBudgets(quote.budgets as readonly Budget[])
    : canonicalizeBudgets([quote.budget as Budget]);
  if (quote.reservationTtlMs !== undefined) {
    assertPositiveInteger(quote.reservationTtlMs as number, 'reservationTtlMs');
  }
  return {
    decision: 'allow',
    units: quote.units as number,
    budgets,
    ...(quote.reservationTtlMs === undefined
      ? {}
      : { reservationTtlMs: quote.reservationTtlMs as number }),
  };
}

function normalizeVectorUsagePolicyQuote(value: unknown): VectorUsageQuote {
  const quote = requireRecord(value, 'Vector usage policy quote');
  if (quote.decision === 'deny') {
    return { decision: 'deny', reason: validatePolicyDenialReason(quote.reason) };
  }
  if (quote.decision !== 'allow') {
    throw new TypeError('Vector usage policy quote decision must be allow or deny');
  }
  if (!Array.isArray(quote.dimensions)) {
    throw new TypeError('Vector usage policy allow quote dimensions must be an array');
  }
  const dimensions = canonicalizeUsageDimensions(quote.dimensions as UsageDimension[]);
  if (quote.reservationTtlMs !== undefined) {
    assertPositiveInteger(quote.reservationTtlMs as number, 'reservationTtlMs');
  }
  return {
    decision: 'allow',
    dimensions,
    ...(quote.reservationTtlMs === undefined
      ? {}
      : { reservationTtlMs: quote.reservationTtlMs as number }),
  };
}

function validatePolicyDenialReason(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_POLICY_DENIAL_REASON_LENGTH
  ) {
    throw new TypeError(
      `Usage policy denial reason must be a non-empty string no longer than ${MAX_POLICY_DENIAL_REASON_LENGTH} characters`,
    );
  }
  return value;
}

function validateStoreReserveResult(
  value: unknown,
  request: UsageRequest,
  units: number,
  budgets: readonly Budget[],
): StoreReserveResult {
  const result = requireStoreResult(value, 'reserve');
  if (result.accepted === false) {
    validateReserveDenial(result, false);
    return result as unknown as StoreReserveResult;
  }
  validateScalarAcceptedReservation(result, request, units, budgets);
  return result as unknown as StoreReserveResult;
}

function validateStoreVectorReserveResult(
  value: unknown,
  request: UsageRequest,
  dimensions: readonly UsageDimension[],
): StoreVectorReserveResult {
  const result = requireStoreResult(value, 'vector reserve');
  if (result.accepted === false) {
    validateReserveDenial(result, true);
    return result as unknown as StoreVectorReserveResult;
  }
  validateVectorAcceptedReservation(result, request, dimensions);
  return result as unknown as StoreVectorReserveResult;
}

function validateStoreGrowthResult(
  value: unknown,
  reservation: ReservationRecord,
  request: ReservationGrowthRequest,
): StoreGrowResult {
  const result = requireStoreResult(value, 'growth');
  validateGrowthCommon(result, reservation.id, request.incrementId);
  if (result.accepted === false) {
    if (result.reason !== 'quota_exceeded') {
      throw new TypeError('UsageStore growth denial reason is invalid');
    }
    validateNonEmptyString(result.limitingBudgetKey, 'UsageStore growth limitingBudgetKey');
    assertNonNegativeStoreInteger(result.remaining, 'UsageStore growth remaining');
    if (!request.budgets.some(budget => budget.key === result.limitingBudgetKey)) {
      throw new TypeError('UsageStore growth limiting budget did not match the request');
    }
    return result as unknown as StoreGrowResult;
  }

  assertNonNegativeStoreInteger(
    result.previousReservedUnits,
    'UsageStore growth previousReservedUnits',
  );
  assertNonNegativeStoreInteger(result.reservedUnits, 'UsageStore growth reservedUnits');
  if (result.previousReservedUnits !== reservation.reservedUnits) {
    throw new TypeError('UsageStore growth previous reservation units did not match local state');
  }
  const expectedReservedUnits = safeAdd(
    reservation.reservedUnits,
    request.additionalUnits,
    'expected growth reservedUnits',
  );
  if (result.reservedUnits !== expectedReservedUnits) {
    throw new TypeError('UsageStore growth reserved units did not match the requested increment');
  }
  validateBudgetRemainingTopology(
    result.remainingByBudget,
    request.budgets.map(budget => budget.key),
    'UsageStore growth remainingByBudget',
  );
  return result as unknown as StoreGrowResult;
}

function validateStoreVectorGrowthResult(
  value: unknown,
  reservation: VectorReservationRecord,
  request: VectorReservationGrowthRequest,
): StoreVectorGrowResult {
  const result = requireStoreResult(value, 'vector growth');
  validateGrowthCommon(result, reservation.id, request.incrementId);
  if (result.accepted === false) {
    if (result.reason !== 'quota_exceeded') {
      throw new TypeError('UsageStore vector growth denial reason is invalid');
    }
    validateNonEmptyString(
      result.limitingDimensionKey,
      'UsageStore vector growth limitingDimensionKey',
    );
    validateNonEmptyString(result.limitingBudgetKey, 'UsageStore vector growth limitingBudgetKey');
    assertNonNegativeStoreInteger(result.remaining, 'UsageStore vector growth remaining');
    const dimension = request.dimensions.find(item => item.key === result.limitingDimensionKey);
    if (!dimension?.budgets.some(budget => budget.key === result.limitingBudgetKey)) {
      throw new TypeError('UsageStore vector growth limiting topology did not match the request');
    }
    return result as unknown as StoreVectorGrowResult;
  }

  validateReservedDimensionTopology(
    result.previousReservedByDimension,
    reservation.dimensions.map(dimension => ({
      key: dimension.key,
      reservedUnits: dimension.reservedUnits,
    })),
    'UsageStore vector growth previousReservedByDimension',
  );
  const growthByKey = new Map(request.dimensions.map(dimension => [dimension.key, dimension] as const));
  validateReservedDimensionTopology(
    result.reservedByDimension,
    reservation.dimensions.map(dimension => ({
      key: dimension.key,
      reservedUnits: safeAdd(
        dimension.reservedUnits,
        growthByKey.get(dimension.key)?.additionalUnits ?? 0,
        'expected vector growth reservedUnits',
      ),
    })),
    'UsageStore vector growth reservedByDimension',
  );
  validateVectorRemainingTopology(
    result.remainingByBudget,
    request.dimensions,
    'UsageStore vector growth remainingByBudget',
  );
  return result as unknown as StoreVectorGrowResult;
}

function requireStoreResult(value: unknown, operation: string): Record<string, unknown> & { accepted: boolean } {
  const result = requireRecord(value, `UsageStore ${operation} result`);
  if (typeof result.accepted !== 'boolean') {
    throw new TypeError(`UsageStore ${operation} result accepted must be a boolean`);
  }
  return result as Record<string, unknown> & { accepted: boolean };
}

function validateGrowthCommon(
  result: Record<string, unknown>,
  reservationId: string,
  incrementId: string,
): void {
  if (typeof result.replayed !== 'boolean') {
    throw new TypeError('UsageStore growth replayed must be a boolean');
  }
  if (result.reservationId !== reservationId || result.incrementId !== incrementId) {
    throw new TypeError('UsageStore growth result identity did not match the request');
  }
  validateNonEmptyString(result.growthCursor, 'UsageStore growthCursor');
}

function validateReserveDenial(result: Record<string, unknown>, vector: boolean): void {
  if (result.reason !== 'quota_exceeded' && result.reason !== 'duplicate_operation') {
    throw new TypeError('UsageStore reserve denial reason is invalid');
  }
  if (result.limitingBudgetKey !== undefined) {
    validateNonEmptyString(result.limitingBudgetKey, 'UsageStore limitingBudgetKey');
  }
  if (vector && result.limitingDimensionKey !== undefined) {
    validateNonEmptyString(result.limitingDimensionKey, 'UsageStore limitingDimensionKey');
  }
  if (result.remaining !== undefined) {
    assertNonNegativeStoreInteger(result.remaining, 'UsageStore remaining');
  }
}

function validateScalarAcceptedReservation(
  result: Record<string, unknown>,
  request: UsageRequest,
  units: number,
  budgets: readonly Budget[],
): void {
  const reservation = requireRecord(result.reservation, 'UsageStore accepted reservation');
  validateNonEmptyString(reservation.id, 'UsageStore reservation id');
  if (
    reservation.operationId !== request.operationId ||
    reservation.principalId !== request.principal.id ||
    reservation.tenantId !== request.principal.tenantId ||
    reservation.plan !== request.principal.plan ||
    reservation.tool !== request.tool
  ) {
    throw new TypeError('UsageStore accepted reservation identity did not match the request');
  }
  assertNonNegativeStoreInteger(reservation.reservedUnits, 'UsageStore reservation reservedUnits');
  if (reservation.reservedUnits !== units) {
    throw new TypeError('UsageStore accepted reservation units did not match the request');
  }
  assertPositiveStoreInteger(reservation.expiresAt, 'UsageStore reservation expiresAt');
  validateOptionalNonEmptyString(reservation.growthCursor, 'UsageStore reservation growthCursor');
  validateStringSet(
    reservation.budgetKeys,
    budgets.map(budget => budget.key),
    'UsageStore reservation budgetKeys',
  );
  validateBudgetRemainingTopology(
    result.remainingByBudget,
    budgets.map(budget => budget.key),
    'UsageStore remainingByBudget',
  );
}

function validateVectorAcceptedReservation(
  result: Record<string, unknown>,
  request: UsageRequest,
  dimensions: readonly UsageDimension[],
): void {
  const reservation = requireRecord(result.reservation, 'UsageStore accepted vector reservation');
  validateNonEmptyString(reservation.id, 'UsageStore vector reservation id');
  if (
    reservation.operationId !== request.operationId ||
    reservation.principalId !== request.principal.id ||
    reservation.tenantId !== request.principal.tenantId ||
    reservation.plan !== request.principal.plan ||
    reservation.tool !== request.tool
  ) {
    throw new TypeError('UsageStore accepted vector reservation identity did not match the request');
  }
  assertPositiveStoreInteger(reservation.expiresAt, 'UsageStore vector reservation expiresAt');
  validateOptionalNonEmptyString(
    reservation.growthCursor,
    'UsageStore vector reservation growthCursor',
  );
  if (!Array.isArray(reservation.dimensions) || reservation.dimensions.length !== dimensions.length) {
    throw new TypeError('UsageStore accepted vector reservation dimensions did not match the request');
  }
  const expectedByKey = new Map(dimensions.map(dimension => [dimension.key, dimension] as const));
  const seen = new Set<string>();
  for (const raw of reservation.dimensions) {
    const dimension = requireRecord(raw, 'UsageStore vector reservation dimension');
    validateNonEmptyString(dimension.key, 'UsageStore vector reservation dimension key');
    const expected = expectedByKey.get(dimension.key);
    if (!expected || seen.has(dimension.key)) {
      throw new TypeError('UsageStore accepted vector reservation topology did not match the request');
    }
    seen.add(dimension.key);
    assertNonNegativeStoreInteger(
      dimension.reservedUnits,
      'UsageStore vector reservation reservedUnits',
    );
    if (dimension.reservedUnits !== expected.units) {
      throw new TypeError('UsageStore accepted vector reservation units did not match the request');
    }
    validateStringSet(
      dimension.budgetKeys,
      expected.budgets.map(budget => budget.key),
      'UsageStore vector reservation budgetKeys',
    );
  }
  validateVectorRemainingTopology(
    result.remainingByBudget,
    dimensions,
    'UsageStore vector remainingByBudget',
  );
}

function validateBudgetRemainingTopology(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): void {
  if (!Array.isArray(value) || value.length !== expectedKeys.length) {
    throw new TypeError(`${name} did not match requested budgets`);
  }
  const expected = new Set(expectedKeys);
  const seen = new Set<string>();
  for (const raw of value) {
    const balance = requireRecord(raw, name);
    validateNonEmptyString(balance.key, `${name} key`);
    if (!expected.has(balance.key) || seen.has(balance.key)) {
      throw new TypeError(`${name} did not match requested budgets`);
    }
    seen.add(balance.key);
    assertNonNegativeStoreInteger(balance.remaining, `${name} remaining`);
  }
}

function validateVectorRemainingTopology(
  value: unknown,
  dimensions: readonly { key: string; budgets: readonly Budget[] }[],
  name: string,
): void {
  const expected = new Set(
    dimensions.flatMap(dimension =>
      dimension.budgets.map(budget => `${dimension.key}\u0000${budget.key}`),
    ),
  );
  if (!Array.isArray(value) || value.length !== expected.size) {
    throw new TypeError(`${name} did not match requested vector budgets`);
  }
  const seen = new Set<string>();
  for (const raw of value) {
    const balance = requireRecord(raw, name);
    validateNonEmptyString(balance.dimensionKey, `${name} dimensionKey`);
    validateNonEmptyString(balance.budgetKey, `${name} budgetKey`);
    const key = `${balance.dimensionKey}\u0000${balance.budgetKey}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new TypeError(`${name} did not match requested vector budgets`);
    }
    seen.add(key);
    assertNonNegativeStoreInteger(balance.remaining, `${name} remaining`);
  }
}

function validateReservedDimensionTopology(
  value: unknown,
  expected: readonly { key: string; reservedUnits: number }[],
  name: string,
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new TypeError(`${name} did not match reservation dimensions`);
  }
  const expectedByKey = new Map(expected.map(dimension => [dimension.key, dimension.reservedUnits]));
  const seen = new Set<string>();
  for (const raw of value) {
    const dimension = requireRecord(raw, name);
    validateNonEmptyString(dimension.key, `${name} key`);
    assertNonNegativeStoreInteger(dimension.reservedUnits, `${name} reservedUnits`);
    if (
      seen.has(dimension.key) ||
      expectedByKey.get(dimension.key) !== dimension.reservedUnits
    ) {
      throw new TypeError(`${name} did not match reservation dimensions`);
    }
    seen.add(dimension.key);
  }
}

function validateStringSet(value: unknown, expected: readonly string[], name: string): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new TypeError(`${name} did not match requested identifiers`);
  }
  const expectedSet = new Set(expected);
  const seen = new Set<string>();
  for (const item of value) {
    validateNonEmptyString(item, name);
    if (!expectedSet.has(item) || seen.has(item)) {
      throw new TypeError(`${name} did not match requested identifiers`);
    }
    seen.add(item);
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function validateOptionalNonEmptyString(value: unknown, name: string): void {
  if (value !== undefined) validateNonEmptyString(value, name);
}

function assertNonNegativeStoreInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveStoreInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function canonicalizeBudgets(budgets: readonly Budget[]): Budget[] {
  if (!Array.isArray(budgets)) throw new TypeError('budgets must be an array');
  if (budgets.length === 0) throw new RangeError('budgets must contain at least one budget');
  const normalized = budgets.map(budget => {
    if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
      throw new TypeError('budget must be an object');
    }
    if (typeof budget.key !== 'string' || budget.key.length === 0) {
      throw new RangeError('budget.key must be a non-empty string');
    }
    assertNonNegativeInteger(budget.limit, `budget.limit (${budget.key})`);
    return { key: budget.key, limit: budget.limit };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i - 1]!.key === normalized[i]!.key) {
      throw new RangeError(`duplicate budget key: ${normalized[i]!.key}`);
    }
  }
  return normalized;
}

function validateRequestIdentity(request: UsageRequest): void {
  if (!request.operationId) throw new RangeError('operationId must be non-empty');
  if (!request.principal.id) throw new RangeError('principal.id must be non-empty');
  if (!request.tool) throw new RangeError('tool must be non-empty');
}

function cloneReservationRecord(reservation: ReservationRecord): ReservationRecord {
  if (typeof reservation.id !== 'string' || reservation.id.length === 0) {
    throw new UsageStateError('Resume reservation id must be non-empty');
  }
  if (typeof reservation.operationId !== 'string' || reservation.operationId.length === 0) {
    throw new UsageStateError('Resume operationId must be non-empty');
  }
  if (typeof reservation.principalId !== 'string' || reservation.principalId.length === 0) {
    throw new UsageStateError('Resume principalId must be non-empty');
  }
  if (typeof reservation.tool !== 'string' || reservation.tool.length === 0) {
    throw new UsageStateError('Resume tool must be non-empty');
  }
  if (!Array.isArray(reservation.budgetKeys) || reservation.budgetKeys.length === 0) {
    throw new UsageStateError('Resume reservation must contain budget keys');
  }
  if (reservation.budgetKeys.some(key => typeof key !== 'string' || key.length === 0)) {
    throw new UsageStateError('Resume budget keys must be non-empty strings');
  }
  assertNonNegativeInteger(reservation.reservedUnits, 'reservedUnits');
  assertPositiveInteger(reservation.expiresAt, 'expiresAt');
  if (
    reservation.growthCursor !== undefined &&
    (typeof reservation.growthCursor !== 'string' || reservation.growthCursor.length === 0)
  ) {
    throw new UsageStateError('Resume growthCursor must be a non-empty string when present');
  }
  return {
    id: reservation.id,
    operationId: reservation.operationId,
    principalId: reservation.principalId,
    ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
    ...(reservation.plan === undefined ? {} : { plan: reservation.plan }),
    tool: reservation.tool,
    budgetKeys: [...reservation.budgetKeys],
    reservedUnits: reservation.reservedUnits,
    expiresAt: reservation.expiresAt,
    ...(reservation.growthCursor === undefined
      ? {}
      : { growthCursor: reservation.growthCursor }),
  };
}

function isProgressiveUsageStore(store: UsageStore): store is ProgressiveUsageStore {
  return typeof (store as Partial<ProgressiveUsageStore>).growReservation === 'function';
}

function isVectorUsageStore(store: UsageStore): store is VectorUsageStore {
  const candidate = store as Partial<VectorUsageStore>;
  return (
    typeof candidate.reserveVector === 'function' &&
    typeof candidate.growVectorReservation === 'function' &&
    typeof candidate.settleVector === 'function'
  );
}

function canonicalizeUsageDimensions(dimensions: readonly UsageDimension[]): UsageDimension[] {
  if (!Array.isArray(dimensions)) throw new TypeError('dimensions must be an array');
  if (dimensions.length === 0) {
    throw new RangeError('dimensions must contain at least one dimension');
  }
  const normalized = dimensions.map(dimension => {
    if (dimension === null || typeof dimension !== 'object' || Array.isArray(dimension)) {
      throw new TypeError('dimension must be an object');
    }
    if (typeof dimension.key !== 'string' || dimension.key.length === 0) {
      throw new RangeError('dimension.key must be a non-empty string');
    }
    assertNonNegativeInteger(dimension.units, `dimension.units (${dimension.key})`);
    return {
      key: dimension.key,
      units: dimension.units,
      budgets: canonicalizeBudgets(dimension.budgets),
    };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  assertUniqueVectorTopology(normalized.map(dimension => ({
    key: dimension.key,
    budgets: dimension.budgets,
  })));
  return normalized;
}

function canonicalizeVectorGrowthDimensions(
  dimensions: readonly UsageDimensionGrowth[],
): UsageDimensionGrowth[] {
  if (dimensions.length === 0) {
    throw new RangeError('dimensions must contain at least one dimension');
  }
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
  assertUniqueVectorTopology(normalized.map(dimension => ({
    key: dimension.key,
    budgets: dimension.budgets,
  })));
  if (!normalized.some(dimension => dimension.additionalUnits > 0)) {
    throw new RangeError('vector growth must add units to at least one dimension');
  }
  return normalized;
}

function assertUniqueVectorTopology(
  dimensions: readonly { key: string; budgets: readonly Budget[] }[],
): void {
  const dimensionKeys = new Set<string>();
  const budgetKeys = new Set<string>();
  for (const dimension of dimensions) {
    if (dimensionKeys.has(dimension.key)) {
      throw new RangeError(`duplicate dimension key: ${dimension.key}`);
    }
    dimensionKeys.add(dimension.key);
    for (const budget of dimension.budgets) {
      if (budgetKeys.has(budget.key)) {
        throw new RangeError(`budget key cannot appear in multiple vector dimensions: ${budget.key}`);
      }
      budgetKeys.add(budget.key);
    }
  }
}

function cloneVectorReservationRecord(
  reservation: VectorReservationRecord,
): VectorReservationRecord {
  if (typeof reservation.id !== 'string' || reservation.id.length === 0) {
    throw new UsageStateError('Resume vector reservation id must be non-empty');
  }
  if (typeof reservation.operationId !== 'string' || reservation.operationId.length === 0) {
    throw new UsageStateError('Resume vector operationId must be non-empty');
  }
  if (typeof reservation.principalId !== 'string' || reservation.principalId.length === 0) {
    throw new UsageStateError('Resume vector principalId must be non-empty');
  }
  if (typeof reservation.tool !== 'string' || reservation.tool.length === 0) {
    throw new UsageStateError('Resume vector tool must be non-empty');
  }
  if (!Array.isArray(reservation.dimensions) || reservation.dimensions.length === 0) {
    throw new UsageStateError('Resume vector reservation must contain dimensions');
  }
  const dimensions = reservation.dimensions.map(dimension => {
    if (typeof dimension.key !== 'string' || dimension.key.length === 0) {
      throw new UsageStateError('Resume vector dimension keys must be non-empty strings');
    }
    if (!Array.isArray(dimension.budgetKeys) || dimension.budgetKeys.length === 0) {
      throw new UsageStateError('Resume vector dimension must contain budget keys');
    }
    if (dimension.budgetKeys.some(key => typeof key !== 'string' || key.length === 0)) {
      throw new UsageStateError('Resume vector budget keys must be non-empty strings');
    }
    assertNonNegativeInteger(dimension.reservedUnits, `reservedUnits (${dimension.key})`);
    return {
      key: dimension.key,
      budgetKeys: [...dimension.budgetKeys].sort((a, b) => a.localeCompare(b)),
      reservedUnits: dimension.reservedUnits,
    };
  });
  dimensions.sort((a, b) => a.key.localeCompare(b.key));
  assertUniqueVectorTopology(
    dimensions.map(dimension => ({
      key: dimension.key,
      budgets: dimension.budgetKeys.map(key => ({ key, limit: 0 })),
    })),
  );
  assertPositiveInteger(reservation.expiresAt, 'expiresAt');
  if (
    reservation.growthCursor !== undefined &&
    (typeof reservation.growthCursor !== 'string' || reservation.growthCursor.length === 0)
  ) {
    throw new UsageStateError('Resume vector growthCursor must be a non-empty string when present');
  }
  return {
    id: reservation.id,
    operationId: reservation.operationId,
    principalId: reservation.principalId,
    ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
    ...(reservation.plan === undefined ? {} : { plan: reservation.plan }),
    tool: reservation.tool,
    dimensions,
    expiresAt: reservation.expiresAt,
    ...(reservation.growthCursor === undefined ? {} : { growthCursor: reservation.growthCursor }),
  };
}

function canonicalizeVectorGrowthRequest(
  input: VectorReservationGrowthRequest,
): VectorReservationGrowthRequest {
  if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
    throw new RangeError('incrementId must be a non-empty string');
  }
  return {
    incrementId: input.incrementId,
    dimensions: canonicalizeVectorGrowthDimensions(input.dimensions),
  };
}

function cloneVectorGrowthRequest(
  input: VectorReservationGrowthRequest,
): VectorReservationGrowthRequest {
  return {
    incrementId: input.incrementId,
    dimensions: input.dimensions.map(dimension => ({
      key: dimension.key,
      additionalUnits: dimension.additionalUnits,
      budgets: dimension.budgets.map(budget => ({ ...budget })),
    })),
  };
}

function sameVectorGrowthRequest(
  left: VectorReservationGrowthRequest,
  right: VectorReservationGrowthRequest,
): boolean {
  return (
    left.incrementId === right.incrementId &&
    vectorGrowthFingerprint(left.dimensions) === vectorGrowthFingerprint(right.dimensions)
  );
}

function vectorGrowthFingerprint(dimensions: readonly UsageDimensionGrowth[]): string {
  return JSON.stringify(
    dimensions.map(dimension => [
      dimension.key,
      dimension.additionalUnits,
      dimension.budgets.map(budget => [budget.key, budget.limit]),
    ]),
  );
}

function canonicalizeVectorActuals(
  actualByDimension: readonly UsageDimensionActual[],
  reservedDimensions: readonly VectorReservationDimension[],
): UsageDimensionActual[] {
  if (actualByDimension.length !== reservedDimensions.length) {
    throw new UsageStateError('Vector settlement must report every reservation dimension exactly once');
  }
  const normalized = actualByDimension.map(item => {
    if (typeof item.key !== 'string' || item.key.length === 0) {
      throw new RangeError('actual dimension key must be a non-empty string');
    }
    assertNonNegativeInteger(item.actualUnits, `actualUnits (${item.key})`);
    return { key: item.key, actualUnits: item.actualUnits };
  });
  normalized.sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 0; index < normalized.length; index += 1) {
    const actual = normalized[index]!;
    const reserved = reservedDimensions[index]!;
    if (actual.key !== reserved.key) {
      throw new UsageStateError('Vector settlement dimension keys do not match the reservation');
    }
    if (actual.actualUnits > reserved.reservedUnits) {
      throw new UsageStateError(
        `actualUnits cannot exceed reservedUnits for dimension ${actual.key}`,
      );
    }
  }
  return normalized;
}

function canonicalizeGrowthRequest(input: ReservationGrowthRequest): ReservationGrowthRequest {
  if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
    throw new RangeError('incrementId must be a non-empty string');
  }
  assertPositiveInteger(input.additionalUnits, 'additionalUnits');
  return {
    incrementId: input.incrementId,
    additionalUnits: input.additionalUnits,
    budgets: canonicalizeBudgets(input.budgets),
  };
}

function cloneGrowthRequest(input: ReservationGrowthRequest): ReservationGrowthRequest {
  return {
    incrementId: input.incrementId,
    additionalUnits: input.additionalUnits,
    budgets: input.budgets.map(budget => ({ ...budget })),
  };
}

function sameGrowthRequest(
  left: ReservationGrowthRequest,
  right: ReservationGrowthRequest,
): boolean {
  return (
    left.incrementId === right.incrementId &&
    growthFingerprint(left.additionalUnits, left.budgets) ===
      growthFingerprint(right.additionalUnits, right.budgets)
  );
}

function validateGrowthInput(input: GrowReservationInput): void {
  if (typeof input.reservationId !== 'string' || input.reservationId.length === 0) {
    throw new RangeError('reservationId must be a non-empty string');
  }
  if (typeof input.incrementId !== 'string' || input.incrementId.length === 0) {
    throw new RangeError('incrementId must be a non-empty string');
  }
  if (typeof input.expectedGrowthCursor !== 'string' || input.expectedGrowthCursor.length === 0) {
    throw new RangeError('expectedGrowthCursor must be a non-empty string');
  }
  assertPositiveInteger(input.additionalUnits, 'additionalUnits');
}

function growthFingerprint(additionalUnits: number, budgets: readonly Budget[]): string {
  return JSON.stringify([additionalUnits, budgets.map(budget => [budget.key, budget.limit])]);
}

function sameBudgetKeys(reservationBudgetKeys: readonly string[], budgets: readonly Budget[]): boolean {
  return (
    reservationBudgetKeys.length === budgets.length &&
    reservationBudgetKeys.every((key, index) => key === budgets[index]!.key)
  );
}

function newGrowthCursor(): string {
  return `g1.${randomUUID()}`;
}

function replayGrowthResult(result: StoreGrowResult): StoreGrowResult {
  return { ...cloneGrowthResult(result), replayed: true };
}

function cloneGrowthResult(result: StoreGrowResult): StoreGrowResult {
  if (result.accepted) {
    return {
      ...result,
      remainingByBudget: result.remainingByBudget.map(balance => ({ ...balance })),
    };
  }
  return { ...result };
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${name} exceeds safe integer range`);
  }
  return result;
}

function requestIdentity(request: UsageRequest): {
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  operationId: string;
} {
  return {
    principalId: request.principal.id,
    ...(request.principal.tenantId === undefined ? {} : { tenantId: request.principal.tenantId }),
    ...(request.principal.plan === undefined ? {} : { plan: request.principal.plan }),
    tool: request.tool,
    operationId: request.operationId,
  };
}

function vectorReservationIdentity(reservation: VectorReservationRecord): {
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  operationId: string;
} {
  return {
    principalId: reservation.principalId,
    ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
    ...(reservation.plan === undefined ? {} : { plan: reservation.plan }),
    tool: reservation.tool,
    operationId: reservation.operationId,
  };
}

function reservationIdentity(reservation: ReservationRecord): {
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  operationId: string;
} {
  return {
    principalId: reservation.principalId,
    ...(reservation.tenantId === undefined ? {} : { tenantId: reservation.tenantId }),
    ...(reservation.plan === undefined ? {} : { plan: reservation.plan }),
    tool: reservation.tool,
    operationId: reservation.operationId,
  };
}

function resolveMetadata(
  metadata: UsageControlOptions['metadata'],
  request: UsageRequest,
): UsageEventMetadata | undefined {
  if (!metadata) return undefined;
  if (typeof metadata !== 'function') return metadata;
  try {
    return metadata(request);
  } catch {
    return undefined;
  }
}

function toSettlement(reservation: InternalScalarReservation): SettlementResult {
  const actualUnits = reservation.actualUnits ?? reservation.reservedUnits;
  return {
    reservationId: reservation.id,
    reservedUnits: reservation.reservedUnits,
    actualUnits,
    releasedUnits: reservation.reservedUnits - actualUnits,
    outcome: reservation.outcome ?? 'unknown',
  };
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
