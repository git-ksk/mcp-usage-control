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
      reservedUnits: number;
      count: number;
    })
  | (UsageEventBase &
      Partial<RequestIdentityFields> & {
        type: 'operation.error';
        phase: 'quote' | 'reserve' | 'mark_liable' | 'renew' | 'settle';
        source: 'policy' | 'store' | 'runtime';
        reservationId?: string;
        /** Error class/name only. Raw exception messages are intentionally omitted. */
        errorName: string;
      });

/**
 * Best-effort, non-blocking observer delivery. Observer failures never change
 * admission/settlement state and are intentionally swallowed.
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
  if (error instanceof Error && error.name) return error.name;
  return 'UnknownError';
}
