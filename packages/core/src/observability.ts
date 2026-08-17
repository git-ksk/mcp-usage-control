export type UsageEventMetadataValue = string | number | boolean | null;

/** Explicit opt-in metadata. Tool arguments and secrets are never captured automatically. */
export type UsageEventMetadata = Readonly<Record<string, UsageEventMetadataValue>>;

export interface UsageObserverHandler {
  onEvent(event: UsageEvent): void | Promise<void>;
}

/** Observer configuration may be omitted without weakening exact optional property checks. */
export type UsageObserver = UsageObserverHandler | undefined;

interface UsageEventBase {
  timestamp: number;
  metadata?: UsageEventMetadata;
}

interface RequestIdentityFields {
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  operationId: string;
}

export type UsageEvent =
  | (UsageEventBase &
      RequestIdentityFields & {
        type: 'reserve.accepted';
        reservationId: string;
        budgetKeys: readonly string[];
        reservedUnits: number;
        remainingByBudget: readonly { key: string; remaining: number }[];
      })
  | (UsageEventBase &
      RequestIdentityFields & {
        type: 'reserve.denied';
        reason: string;
        limitingBudgetKey?: string;
        remaining?: number;
      })
  | (UsageEventBase &
      RequestIdentityFields & {
        type: 'vector.reserve.accepted';
        reservationId: string;
        dimensions: readonly {
          key: string;
          reservedUnits: number;
          budgetKeys: readonly string[];
        }[];
        remainingByBudget: readonly {
          dimensionKey: string;
          budgetKey: string;
          remaining: number;
        }[];
      })
  | (UsageEventBase &
      RequestIdentityFields & {
        type: 'vector.reserve.denied';
        reason: string;
        limitingDimensionKey?: string;
        limitingBudgetKey?: string;
        remaining?: number;
      })
  | (UsageEventBase &
      RequestIdentityFields & {
        type: 'settlement.completed';
        reservationId: string;
        budgetKeys: readonly string[];
        reservedUnits: number;
        actualUnits: number;
        releasedUnits: number;
        outcome: string;
      })
  | (UsageEventBase &
      RequestIdentityFields & {
        type: 'vector.settlement.completed';
        reservationId: string;
        dimensions: readonly {
          key: string;
          reservedUnits: number;
          actualUnits: number;
          releasedUnits: number;
        }[];
        outcome: string;
      })
  | (UsageEventBase & {
      type: 'vector.reservation.recovered';
      store: 'memory' | 'redis' | 'cloudflare';
      recovery: 'pending_released' | 'liable_retained';
      reservationId?: string;
      principalId?: string;
      tenantId?: string;
      tool?: string;
      dimensionCount?: number;
      budgetCount?: number;
      count: number;
    })
  | (UsageEventBase & {
      type: 'reservation.recovered';
      store: 'memory' | 'redis' | 'cloudflare';
      recovery: 'pending_released' | 'liable_retained';
      /** Distributed-store recovery IDs are opaque hashes; memory-store IDs are local reference IDs. */
      reservationId?: string;
      principalId?: string;
      tenantId?: string;
      tool?: string;
      budgetIdentifiers?: readonly string[];
      /** Aggregate total when count > 1. */
      reservedUnits: number;
      count: number;
    })
  | (UsageEventBase &
      Partial<RequestIdentityFields> & {
        type: 'operation.error';
        phase: 'quote' | 'reserve' | 'mark_liable' | 'renew' | 'settle';
        source: 'policy' | 'store' | 'runtime';
        reservationId?: string;
        /** Bounded constructor class name only. Raw exception messages/names are omitted. */
        errorName: string;
      });

export type UsageLogResult = 'success' | 'denied' | 'error' | 'recovery';
export type UsageLogPhase = 'quote' | 'reserve' | 'mark_liable' | 'renew' | 'settle' | 'recovery';
export type UsageLogDenialReason = 'quota_exceeded' | 'duplicate_operation' | 'policy_denied';
export type UsageLogErrorClass =
  | 'Error'
  | 'TypeError'
  | 'RangeError'
  | 'UsageStateError'
  | 'UsageDeniedError'
  | 'CloudflareUsageTransportError'
  | 'UnknownError'
  | 'OtherError';

/**
 * Operations-safe, low-cardinality projection of a UsageEvent.
 *
 * Identity fields, reservation IDs, tool/budget identifiers, settlement outcome,
 * and application-defined reason strings are deliberately excluded by default.
 */
export interface UsageLogRecord {
  timestamp: number;
  eventType: UsageEvent['type'];
  phase: UsageLogPhase;
  result: UsageLogResult;
  source?: 'policy' | 'store' | 'runtime';
  denialReason?: UsageLogDenialReason;
  errorClass?: UsageLogErrorClass;
  store?: 'memory' | 'redis' | 'cloudflare';
  recovery?: 'pending_released' | 'liable_retained';
  reservedUnits?: number;
  actualUnits?: number;
  releasedUnits?: number;
  remaining?: number;
  budgetCount?: number;
  remainingMin?: number;
  remainingMax?: number;
  count?: number;
  dimensionCount?: number;
  /** Explicit opt-in only; callers remain responsible for metadata privacy/cardinality. */
  metadata?: UsageEventMetadata;
}

export interface UsageLogProjectionOptions {
  /** Copy explicit UsageEvent metadata into the log record. Disabled by default. */
  includeMetadata?: boolean;
}

/**
 * Project a raw lifecycle event into a log-safe shape suitable for JSON logs and
 * bounded operational metrics. This helper is pure and never affects enforcement.
 */
export function projectUsageEvent(
  event: UsageEvent,
  options: UsageLogProjectionOptions = {},
): UsageLogRecord {
  const metadata =
    options.includeMetadata === true && event.metadata !== undefined
      ? { metadata: { ...event.metadata } }
      : {};

  if (event.type === 'reserve.accepted') {
    const remaining = summarizeRemaining(event.remainingByBudget);
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'reserve',
      result: 'success',
      reservedUnits: event.reservedUnits,
      ...remaining,
      ...metadata,
    };
  }

  if (event.type === 'reserve.denied') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'reserve',
      result: 'denied',
      denialReason: normalizeDenialReason(event.reason),
      ...(event.remaining === undefined ? {} : { remaining: event.remaining }),
      ...metadata,
    };
  }

  if (event.type === 'vector.reserve.accepted') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'reserve',
      result: 'success',
      dimensionCount: event.dimensions.length,
      budgetCount: event.remainingByBudget.length,
      ...metadata,
    };
  }

  if (event.type === 'vector.reserve.denied') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'reserve',
      result: 'denied',
      denialReason: normalizeDenialReason(event.reason),
      ...(event.remaining === undefined ? {} : { remaining: event.remaining }),
      ...metadata,
    };
  }

  if (event.type === 'settlement.completed') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'settle',
      result: 'success',
      reservedUnits: event.reservedUnits,
      actualUnits: event.actualUnits,
      releasedUnits: event.releasedUnits,
      ...metadata,
    };
  }

  if (event.type === 'vector.settlement.completed') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'settle',
      result: 'success',
      dimensionCount: event.dimensions.length,
      ...metadata,
    };
  }

  if (event.type === 'vector.reservation.recovered') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'recovery',
      result: 'recovery',
      store: event.store,
      recovery: event.recovery,
      ...(event.dimensionCount === undefined ? {} : { dimensionCount: event.dimensionCount }),
      ...(event.budgetCount === undefined ? {} : { budgetCount: event.budgetCount }),
      count: event.count,
      ...metadata,
    };
  }

  if (event.type === 'reservation.recovered') {
    return {
      timestamp: event.timestamp,
      eventType: event.type,
      phase: 'recovery',
      result: 'recovery',
      store: event.store,
      recovery: event.recovery,
      reservedUnits: event.reservedUnits,
      count: event.count,
      ...metadata,
    };
  }

  return {
    timestamp: event.timestamp,
    eventType: event.type,
    phase: event.phase,
    result: 'error',
    source: event.source,
    errorClass: normalizeErrorClass(event.errorName),
    ...metadata,
  };
}

/**
 * Best-effort observer delivery outside the enforcement outcome. The callback
 * is invoked inline, but returned promises are not awaited. Keep synchronous
 * observer work lightweight and offload network/durable I/O yourself.
 * Observer failures never change admission/settlement state.
 */
export function emitUsageEvent(observer: UsageObserver, event: UsageEvent): void {
  if (!observer) return;
  try {
    const result = observer.onEvent(event);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Observability is not part of the enforcement transaction.
  }
}

export function usageErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const constructorName = error.constructor?.name;
  if (
    typeof constructorName === 'string' &&
    /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(constructorName)
  ) {
    return constructorName;
  }
  return 'UnknownError';
}

function normalizeDenialReason(reason: string): UsageLogDenialReason {
  if (reason === 'quota_exceeded' || reason === 'duplicate_operation') return reason;
  return 'policy_denied';
}

function normalizeErrorClass(errorName: string): UsageLogErrorClass {
  switch (errorName) {
    case 'Error':
    case 'TypeError':
    case 'RangeError':
    case 'UsageStateError':
    case 'UsageDeniedError':
    case 'CloudflareUsageTransportError':
    case 'UnknownError':
      return errorName;
    default:
      return 'OtherError';
  }
}

function summarizeRemaining(
  remainingByBudget: readonly { key: string; remaining: number }[],
): Pick<UsageLogRecord, 'budgetCount' | 'remainingMin' | 'remainingMax'> {
  if (remainingByBudget.length === 0) return { budgetCount: 0 };
  const values = remainingByBudget.map(item => item.remaining);
  return {
    budgetCount: values.length,
    remainingMin: Math.min(...values),
    remainingMax: Math.max(...values),
  };
}
