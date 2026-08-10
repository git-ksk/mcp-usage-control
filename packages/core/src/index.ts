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
  | { allowed: true; lease: UsageLease }
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

export class UsageLease {
  constructor(
    private readonly store: UsageStore,
    public readonly reservation: ReservationRecord,
    public readonly ttlMs: number,
  ) {}

  get reservedUnits(): number {
    return this.reservation.reservedUnits;
  }

  async markLiable(): Promise<MarkLiableResult> {
    const marked = await this.store.markLiable({ reservationId: this.reservation.id });
    this.reservation.expiresAt = marked.expiresAt;
    return marked;
  }

  async renew(ttlMs = this.ttlMs): Promise<RenewResult> {
    assertPositiveInteger(ttlMs, 'ttlMs');
    const renewed = await this.store.renew({ reservationId: this.reservation.id, ttlMs });
    this.reservation.expiresAt = renewed.expiresAt;
    return renewed;
  }

  settle(actualUnits: number, outcome: string): Promise<SettlementResult> {
    return this.store.settle({ reservationId: this.reservation.id, actualUnits, outcome });
  }
}

export class UsageControl {
  constructor(
    private readonly store: UsageStore,
    private readonly policy: UsagePolicy,
    private readonly defaultReservationTtlMs = 60_000,
  ) {
    assertPositiveInteger(defaultReservationTtlMs, 'defaultReservationTtlMs');
  }

  async reserve<TArgs>(request: UsageRequest<TArgs>): Promise<AdmissionResult> {
    validateRequestIdentity(request);
    const quote = await this.policy.quote(request as UsageRequest);
    if (quote.decision === 'deny') return { allowed: false, reason: quote.reason };

    assertNonNegativeInteger(quote.units, 'units');
    const budgets = canonicalizeBudgets('budgets' in quote && quote.budgets ? quote.budgets : [quote.budget]);
    const ttlMs = quote.reservationTtlMs ?? this.defaultReservationTtlMs;
    assertPositiveInteger(ttlMs, 'reservationTtlMs');

    const result = await this.store.reserve({
      request: request as UsageRequest,
      units: quote.units,
      budgets,
      ttlMs,
    });

    if (!result.accepted) {
      return {
        allowed: false,
        reason: result.reason,
        ...(result.limitingBudgetKey === undefined
          ? {}
          : { limitingBudgetKey: result.limitingBudgetKey }),
        ...(result.remaining === undefined ? {} : { remaining: result.remaining }),
      };
    }

    return { allowed: true, lease: new UsageLease(this.store, result.reservation, ttlMs) };
  }
}

export interface MemoryUsageStoreOptions {
  /** How long a settled operation remains replay-protected. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
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

  constructor(options: MemoryUsageStoreOptions = {}) {
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? 86_400_000;
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
        continue;
      }

      // Once execution has been marked liable, expiry is conservative: retain
      // the full reservation as consumed so a process crash cannot become a refund.
      reservation.state = 'settled';
      reservation.actualUnits = reservation.reservedUnits;
      reservation.outcome = 'lease_expired_after_execution_started';
      reservation.tombstoneExpiresAt = now + this.idempotencyTtlMs;
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
