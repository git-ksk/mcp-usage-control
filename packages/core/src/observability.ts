export type UsageEventMetadataValue = string | number | boolean | null;

/** Explicit opt-in metadata. Tool arguments and secrets are never captured automatically. */
export type UsageEventMetadata = Readonly<Record<string, UsageEventMetadataValue>>;

export interface UsageObserver {
  onEvent(event: UsageEvent): void | Promise<void>;
}

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
        type: 'settlement.completed';
        reservationId: string;
        budgetKeys: readonly string[];
        reservedUnits: number;
        actualUnits: number;
        releasedUnits: number;
        outcome: string;
      })
  | (UsageEventBase & {
      type: 'reservation.recovered';
      store: 'memory' | 'redis';
      recovery: 'pending_released' | 'liable_retained';
      /** Redis recovery IDs are opaque hashes; memory-store IDs are local reference IDs. */
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

/**
 * Best-effort observer delivery outside the enforcement outcome. The callback
 * is invoked inline, but returned promises are not awaited. Keep synchronous
 * observer work lightweight and offload network/durable I/O yourself.
 * Observer failures never change admission/settlement state.
 */
export function emitUsageEvent(observer: UsageObserver | undefined, event: UsageEvent): void {
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
