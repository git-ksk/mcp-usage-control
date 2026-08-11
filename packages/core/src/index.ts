import {
  emitUsageEvent,
  usageErrorName,
  type UsageEventMetadata,
  type UsageObserver,
} from './observability.js';

export * from './observability.js';

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
}

export class UsageLease {
  constructor(
    private readonly store: UsageStore,
    public readonly reservation: ReservationRecord,
    public readonly ttlMs: number,
    private readonly observer?: UsageObserver,
    private readonly metadata?: UsageEventMetadata,
  ) {}

  get reservedUnits(): number {
    return this.reservation.reservedUnits;
  }

  /** Export a detached snapshot for trusted server-side suspend/resume workflows. */
  toResumeState(): UsageLeaseResumeState {
    return {
      reservation: cloneReservationRecord(this.reservation),
      ttlMs: this.ttlMs,
      ...(this.metadata === undefined ? {} : { metadata: { ...this.metadata } }),
    };
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
    );
  }

  async reserve<TArgs>(request: UsageRequest<TArgs>): Promise<AdmissionResult> {
    validateRequestIdentity(request);
    const requestForPolicy = request as UsageRequest;
    const metadata = resolveMetadata(this.metadata, requestForPolicy);
    let quote: UsageQuote;
    try {
      quote = await this.policy.quote(requestForPolicy);
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

    assertNonNegativeInteger(quote.units, 'units');
    const budgets = canonicalizeBudgets('budgets' in quote && quote.budgets ? quote.budgets : [quote.budget]);
    const ttlMs = quote.reservationTtlMs ?? this.defaultReservationTtlMs;
    assertPositiveInteger(ttlMs, 'reservationTtlMs');

    let result: StoreReserveResult;
    try {
      result = await this.store.reserve({
        request: requestForPolicy,
        units: quote.units,
        budgets,
        ttlMs,
      });
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

export interface MemoryUsageStoreOptions {
  /** How long a settled operation remains replay-protected. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /** Optional best-effort observer for expiry/recovery events. */
  observer?: UsageObserver;
}

interface InternalReservation extends ReservationRecord {
  operationKey: string;
  state: 'pending' | 'liable' | 'settled';
  actualUnits?: number;
  outcome?: string;
  tombstoneExpiresAt?: number;
}

export class MemoryUsageStore implements UsageStore {
  private readonly used = new Map<string, number>();
  private readonly reservations = new Map<string, InternalReservation>();
  private readonly operations = new Map<string, string>();
  private readonly idempotencyTtlMs: number;
  private readonly observer?: UsageObserver;

  constructor(options: MemoryUsageStoreOptions = {}) {
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
    this.observer = options.observer;
    assertPositiveInteger(this.idempotencyTtlMs, 'idempotencyTtlMs');
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

    const reservation: InternalReservation = {
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
      expiresAt: now + input.ttlMs,
      operationKey,
      state: 'pending',
    };

    for (const budget of budgets) {
      this.used.set(budget.key, (this.used.get(budget.key) ?? 0) + input.units);
    }
    this.reservations.set(reservation.id, reservation);
    this.operations.set(operationKey, reservation.id);

    return {
      accepted: true,
      reservation,
      remainingByBudget: remainingByBudget.map(balance => ({
        key: balance.key,
        remaining: balance.remaining - input.units,
      })),
    };
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

  async renew(input: RenewInput): Promise<RenewResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const now = Date.now();
    this.recoverExpired(now);

    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.state === 'settled') {
      throw new UsageStateError('Active reservation not found or expired');
    }

    reservation.expiresAt = now + input.ttlMs;
    return { reservationId: reservation.id, expiresAt: reservation.expiresAt };
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
    const now = Date.now();
    this.recoverExpired(now);
    const reservation = this.reservations.get(input.reservationId);
    if (!reservation) throw new UsageStateError('Reservation not found or expired');

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
    reservation.tombstoneExpiresAt = now + this.idempotencyTtlMs;
    return toSettlement(reservation);
  }

  private recoverExpired(now: number): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.state === 'settled') {
        if ((reservation.tombstoneExpiresAt ?? Number.POSITIVE_INFINITY) <= now) {
          this.operations.delete(reservation.operationKey);
          this.reservations.delete(id);
        }
        continue;
      }
      if (reservation.expiresAt > now) continue;

      if (reservation.state === 'pending') {
        this.releaseAcrossBudgets(reservation.budgetKeys, reservation.reservedUnits);
        this.operations.delete(reservation.operationKey);
        this.reservations.delete(id);
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
        continue;
      }

      // Once execution has been marked liable, expiry is conservative: retain
      // the full reservation as consumed so a process crash cannot become a refund.
      reservation.state = 'settled';
      reservation.actualUnits = reservation.reservedUnits;
      reservation.outcome = 'lease_expired_after_execution_started';
      reservation.tombstoneExpiresAt = now + this.idempotencyTtlMs;
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
    }
  }

  private releaseAcrossBudgets(budgetKeys: readonly string[], units: number): void {
    for (const budgetKey of budgetKeys) {
      const next = Math.max(0, (this.used.get(budgetKey) ?? 0) - units);
      if (next === 0) this.used.delete(budgetKey);
      else this.used.set(budgetKey, next);
    }
  }
}

function operationKeyFor(request: UsageRequest): string {
  return JSON.stringify([
    request.principal.tenantId ?? null,
    request.principal.id,
    request.tool,
    request.operationId,
  ]);
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
  };
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

function toSettlement(reservation: InternalReservation): SettlementResult {
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
