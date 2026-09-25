import type { ProgressiveUsageStore, VectorUsageStore } from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  type RemoteCloudflareUsageStore,
} from './index.js';

const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 1_000;
const MAX_CONFIGURED_BACKOFF_MS = 60_000;

export type RemoteCloudflareExactRetryPhase = 'mark_liable' | 'renew' | 'settle';

export type RemoteCloudflareExactRetryTransportClass =
  | 'timeout'
  | 'network'
  | 'http_408'
  | 'http_429'
  | 'http_5xx';

export type RemoteCloudflareExactRetryEvent =
  | {
      type: 'retry.scheduled';
      timestamp: number;
      phase: RemoteCloudflareExactRetryPhase;
      attempt: number;
      maxAttempts: number;
      transportClass: RemoteCloudflareExactRetryTransportClass;
      delayMs: number;
    }
  | {
      type: 'retry.recovered';
      timestamp: number;
      phase: RemoteCloudflareExactRetryPhase;
      attempts: number;
    }
  | {
      type: 'retry.failed';
      timestamp: number;
      phase: RemoteCloudflareExactRetryPhase;
      attempts: number;
      reason: 'attempts_exhausted' | 'non_retryable_after_retry';
      transportClass?: RemoteCloudflareExactRetryTransportClass;
    };

export interface RemoteCloudflareExactRetryObserver {
  onEvent(event: RemoteCloudflareExactRetryEvent): void | Promise<void>;
}

export interface RemoteCloudflareExactRetryOptions {
  /**
   * Total attempts for eligible exact post-reserve replays, including the initial call.
   * Defaults to 2 (one retry) and is capped at 4. Set to 1 to disable retries.
   */
  maxAttempts?: number;
  /** Base delay before the first retry. Defaults to 100ms. */
  initialBackoffMs?: number;
  /** Cap for exponential retry delay. Defaults to 1000ms. */
  maxBackoffMs?: number;
  /** Optional best-effort, privacy-bounded retry lifecycle observer. */
  observer?: RemoteCloudflareExactRetryObserver;
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
  const backoff = normalizeBackoff(options);

  return {
    reserve: input => store.reserve(input),
    reserveVector: input => store.reserveVector(input),
    growReservation: input => store.growReservation(input),
    growVectorReservation: input => store.growVectorReservation(input),
    settleVector: input => store.settleVector(input),

    markLiable: input => {
      const exactInput = { reservationId: input.reservationId };
      return runExactPostReserveReplay(
        'mark_liable',
        () => store.markLiable(exactInput),
        maxAttempts,
        backoff,
        options.observer,
      );
    },

    renew: input => {
      const exactInput = { reservationId: input.reservationId, ttlMs: input.ttlMs };
      return runExactPostReserveReplay(
        'renew',
        () => store.renew(exactInput),
        maxAttempts,
        backoff,
        options.observer,
      );
    },

    settle: input => {
      const exactInput = {
        reservationId: input.reservationId,
        actualUnits: input.actualUnits,
        outcome: input.outcome,
      };
      return runExactPostReserveReplay(
        'settle',
        () => store.settle(exactInput),
        maxAttempts,
        backoff,
        options.observer,
      );
    },
  };
}

interface ExactRetryBackoff {
  initialMs: number;
  maxMs: number;
}

async function runExactPostReserveReplay<T>(
  phase: RemoteCloudflareExactRetryPhase,
  operation: () => Promise<T>,
  maxAttempts: number,
  backoff: ExactRetryBackoff,
  observer: RemoteCloudflareExactRetryObserver | undefined,
): Promise<T> {
  let retryStarted = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await operation();
      if (retryStarted) {
        emitExactRetryEvent(observer, {
          type: 'retry.recovered',
          timestamp: Date.now(),
          phase,
          attempts: attempt,
        });
      }
      return result;
    } catch (error) {
      const transportClass = classifyRetryableExactReplayTransportError(error);
      const retryable = transportClass !== undefined;
      if (attempt >= maxAttempts || !retryable) {
        if (retryStarted) {
          emitExactRetryEvent(observer, {
            type: 'retry.failed',
            timestamp: Date.now(),
            phase,
            attempts: attempt,
            reason: retryable ? 'attempts_exhausted' : 'non_retryable_after_retry',
            ...(transportClass === undefined ? {} : { transportClass }),
          });
        }
        throw error;
      }

      const delayMs = equalJitterBackoffMs(attempt, backoff);
      emitExactRetryEvent(observer, {
        type: 'retry.scheduled',
        timestamp: Date.now(),
        phase,
        attempt: attempt + 1,
        maxAttempts,
        transportClass,
        delayMs,
      });
      retryStarted = true;
      await delay(delayMs);
    }
  }
}

function classifyRetryableExactReplayTransportError(
  error: unknown,
): RemoteCloudflareExactRetryTransportClass | undefined {
  if (!(error instanceof CloudflareUsageTransportError)) return undefined;

  if (error.code === 'timeout' || error.code === 'network') {
    return error.code;
  }

  if (error.code !== 'remote' || error.status === undefined) {
    return undefined;
  }

  if (error.status === 408) return 'http_408';
  if (error.status === 429) return 'http_429';
  if (error.status >= 500 && error.status <= 599) return 'http_5xx';
  return undefined;
}

function normalizeMaxAttempts(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_MAX_ATTEMPTS) {
    throw new RangeError(`maxAttempts must be a safe integer between 1 and ${MAX_MAX_ATTEMPTS}`);
  }
  return resolved;
}

function normalizeBackoff(options: RemoteCloudflareExactRetryOptions): ExactRetryBackoff {
  const initialMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  assertBackoffMs(initialMs, 'initialBackoffMs');
  assertBackoffMs(maxMs, 'maxBackoffMs');
  if (maxMs < initialMs) {
    throw new RangeError('maxBackoffMs must be greater than or equal to initialBackoffMs');
  }
  return { initialMs, maxMs };
}

function assertBackoffMs(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_BACKOFF_MS) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${MAX_CONFIGURED_BACKOFF_MS}`);
  }
}

function equalJitterBackoffMs(failedAttempt: number, backoff: ExactRetryBackoff): number {
  const exponential = Math.min(backoff.maxMs, backoff.initialMs * 2 ** (failedAttempt - 1));
  const floor = Math.ceil(exponential / 2);
  return floor + Math.floor(Math.random() * (exponential - floor + 1));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function emitExactRetryEvent(
  observer: RemoteCloudflareExactRetryObserver | undefined,
  event: RemoteCloudflareExactRetryEvent,
): void {
  if (!observer) return;
  try {
    const result = observer.onEvent(event);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Retry telemetry is best-effort and never part of accounting/enforcement.
  }
}
