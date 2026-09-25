import type { ProgressiveUsageStore, VectorUsageStore } from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  type RemoteCloudflareUsageStore,
} from './index.js';

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_MAX_ATTEMPTS = 4;

export interface RemoteCloudflareExactRetryOptions {
  /**
   * Total attempts for eligible exact post-reserve replays, including the initial call.
   * Defaults to 2 (one retry) and is capped at 4. Set to 1 to disable retries.
   */
  maxAttempts?: number;
}

/**
 * Wraps one RemoteCloudflareUsageStore with a narrowly scoped exact-replay policy.
 *
 * Only scalar markLiable(), renew(), and settle() are retried. Initial reserve(),
 * vector reserve/settlement, and scalar/vector growth remain single-attempt.
 */
export function createExactRetryingRemoteCloudflareUsageStore(
  store: RemoteCloudflareUsageStore,
  options: RemoteCloudflareExactRetryOptions = {},
): ProgressiveUsageStore & VectorUsageStore {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);

  return {
    reserve: input => store.reserve(input),
    reserveVector: input => store.reserveVector(input),
    growReservation: input => store.growReservation(input),
    growVectorReservation: input => store.growVectorReservation(input),
    settleVector: input => store.settleVector(input),

    markLiable: input => {
      const exactInput = { reservationId: input.reservationId };
      return runExactPostReserveReplay(() => store.markLiable(exactInput), maxAttempts);
    },

    renew: input => {
      const exactInput = { reservationId: input.reservationId, ttlMs: input.ttlMs };
      return runExactPostReserveReplay(() => store.renew(exactInput), maxAttempts);
    },

    settle: input => {
      const exactInput = {
        reservationId: input.reservationId,
        actualUnits: input.actualUnits,
        outcome: input.outcome,
      };
      return runExactPostReserveReplay(() => store.settle(exactInput), maxAttempts);
    },
  };
}

async function runExactPostReserveReplay<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableExactReplayTransportError(error)) {
        throw error;
      }
    }
  }
}

function isRetryableExactReplayTransportError(error: unknown): boolean {
  if (!(error instanceof CloudflareUsageTransportError)) return false;

  if (error.code === 'timeout' || error.code === 'network') {
    return true;
  }

  if (error.code !== 'remote' || error.status === undefined) {
    return false;
  }

  return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599);
}

function normalizeMaxAttempts(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_MAX_ATTEMPTS) {
    throw new RangeError(`maxAttempts must be a safe integer between 1 and ${MAX_MAX_ATTEMPTS}`);
  }
  return resolved;
}
