import type { ScopedQuotaSnapshot } from './operational.js';

export type UsageQuotaThreshold =
  | { kind: 'remaining_units'; value: number }
  | { kind: 'remaining_ratio'; value: number };

export interface UsageQuotaThresholdEvaluation {
  reached: boolean;
  exhausted: boolean;
  remaining: number;
  remainingRatio: number;
}

/**
 * Evaluate one threshold against one explicitly scoped authoritative quota snapshot.
 * This helper is pure and owns no accounting-window or delivery state.
 */
export function evaluateUsageQuotaThreshold(
  quota: ScopedQuotaSnapshot,
  threshold: UsageQuotaThreshold,
): UsageQuotaThresholdEvaluation {
  validateQuota(quota);
  validateThreshold(threshold);
  const remainingRatio = quota.limit === 0 ? 0 : quota.remaining / quota.limit;
  const reached =
    threshold.kind === 'remaining_units'
      ? quota.remaining <= threshold.value
      : remainingRatio <= threshold.value;
  return {
    reached,
    exhausted: quota.remaining === 0,
    remaining: quota.remaining,
    remainingRatio,
  };
}

/**
 * Return true only when the same scoped accounting window moves from above a threshold
 * to at-or-below it. Replaying the same result therefore does not create another crossing.
 * Applications remain responsible for resetting previous state when their window changes.
 */
export function didUsageQuotaThresholdCross(
  previous: ScopedQuotaSnapshot,
  current: ScopedQuotaSnapshot,
  threshold: UsageQuotaThreshold,
): boolean {
  validateQuota(previous);
  validateQuota(current);
  if (previous.limit !== current.limit) {
    throw new RangeError('Threshold crossing requires snapshots from the same configured limit');
  }
  return (
    !evaluateUsageQuotaThreshold(previous, threshold).reached &&
    evaluateUsageQuotaThreshold(current, threshold).reached
  );
}

function validateQuota(quota: ScopedQuotaSnapshot): void {
  if (
    !Number.isSafeInteger(quota.limit) ||
    quota.limit < 0 ||
    !Number.isSafeInteger(quota.remaining) ||
    quota.remaining < 0 ||
    quota.remaining > quota.limit
  ) {
    throw new RangeError('Quota snapshot must contain a valid non-negative limit and remaining value');
  }
}

function validateThreshold(threshold: UsageQuotaThreshold): void {
  if (threshold.kind === 'remaining_units') {
    if (!Number.isSafeInteger(threshold.value) || threshold.value < 0) {
      throw new RangeError('remaining_units threshold must be a non-negative safe integer');
    }
    return;
  }
  if (
    threshold.kind !== 'remaining_ratio' ||
    !Number.isFinite(threshold.value) ||
    threshold.value < 0 ||
    threshold.value > 1
  ) {
    throw new RangeError('remaining_ratio threshold must be between 0 and 1');
  }
}
