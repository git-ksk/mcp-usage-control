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

export type UsageQuote =
  | { decision: 'allow'; units: number; budget: Budget; reservationTtlMs?: number }
  | { decision: 'deny'; reason: string };

export interface UsagePolicy {
  quote(request: UsageRequest): UsageQuote | Promise<UsageQuote>;
}

export interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tool: string;
  budgetKey: string;
  reservedUnits: number;
  expiresAt: number;
}

export type StoreReserveResult =
  | { accepted: true; reservation: ReservationRecord; remaining: number }
  | { accepted: false; reason: 'quota_exceeded' | 'duplicate_operation'; remaining?: number };

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
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult>;
  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}

export type AdmissionResult =
  | { allowed: true; lease: UsageLease }
  | { allowed: false; reason: string; remaining?: number };

export class UsageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageStateError';
  }
}

export class UsageDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`Usage denied: ${reason}`);
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
    const quote = await this.policy.quote(request as UsageRequest);
    if (quote.decision === 'deny') return { allowed: false, reason: quote.reason };

    assertNonNegativeInteger(quote.units, 'units');
    assertNonNegativeInteger(quote.budget.limit, 'budget.limit');
    const ttlMs = quote.reservationTtlMs ?? this.defaultReservationTtlMs;
    assertPositiveInteger(ttlMs, 'reservationTtlMs');

    const result = await this.store.reserve({
      request: request as UsageRequest,
      units: quote.units,
      budget: quote.budget,
      ttlMs,
    });

    if (!result.accepted) {
      return result.remaining === undefined
        ? { allowed: false, reason: result.reason }
        : { allowed: false, reason: result.reason, remaining: result.remaining };
    }

    return { allowed: true, lease: new UsageLease(this.store, result.reservation, ttlMs) };
  }
}

interface InternalReservation extends ReservationRecord {
  state: 'pending' | 'settled';
  actualUnits?: number;
  outcome?: string;
}

export class MemoryUsageStore implements UsageStore {
  private readonly used = new Map<string, number>();
  private readonly reservations = new Map<string, InternalReservation>();
  private readonly operations = new Map<string, string>();

  async reserve(input: {
    request: UsageRequest;
    units: number;
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult> {
    const now = Date.now();
    this.releaseExpired(now);

    const operationKey = `${input.request.principal.id}:${input.request.operationId}`;
    if (this.operations.has(operationKey)) {
      return { accepted: false, reason: 'duplicate_operation' };
    }

    const current = this.used.get(input.budget.key) ?? 0;
    const remaining = Math.max(0, input.budget.limit - current);
    if (input.units > remaining) {
      return { accepted: false, reason: 'quota_exceeded', remaining };
    }

    const reservation: InternalReservation = {
      id: operationKey,
      operationId: input.request.operationId,
      principalId: input.request.principal.id,
      tool: input.request.tool,
      budgetKey: input.budget.key,
      reservedUnits: input.units,
      expiresAt: now + input.ttlMs,
      state: 'pending',
    };

    this.used.set(input.budget.key, current + input.units);
    this.reservations.set(reservation.id, reservation);
    this.operations.set(operationKey, reservation.id);
    return { accepted: true, reservation, remaining: remaining - input.units };
  }

  async renew(input: RenewInput): Promise<RenewResult> {
    assertPositiveInteger(input.ttlMs, 'ttlMs');
    const now = Date.now();
    this.releaseExpired(now);

    const reservation = this.reservations.get(input.reservationId);
    if (!reservation || reservation.state !== 'pending') {
      throw new UsageStateError('Pending reservation not found or expired');
    }

    reservation.expiresAt = now + input.ttlMs;
    return { reservationId: reservation.id, expiresAt: reservation.expiresAt };
  }

  async settle(input: SettleInput): Promise<SettlementResult> {
    assertNonNegativeInteger(input.actualUnits, 'actualUnits');
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
    this.used.set(
      reservation.budgetKey,
      Math.max(0, (this.used.get(reservation.budgetKey) ?? 0) - released),
    );
    reservation.state = 'settled';
    reservation.actualUnits = input.actualUnits;
    reservation.outcome = input.outcome;
    return toSettlement(reservation);
  }

  private releaseExpired(now: number): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.state !== 'pending' || reservation.expiresAt > now) continue;
      this.used.set(
        reservation.budgetKey,
        Math.max(0, (this.used.get(reservation.budgetKey) ?? 0) - reservation.reservedUnits),
      );
      this.operations.delete(`${reservation.principalId}:${reservation.operationId}`);
      this.reservations.delete(id);
    }
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
