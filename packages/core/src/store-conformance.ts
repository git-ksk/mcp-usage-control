export * from './progressive-store-conformance.js';
import type { Budget, StoreReserveResult, UsageRequest, UsageStore } from './index.js';

type MaybePromise<T> = T | Promise<T>;

export interface UsageStoreConformanceHarness {
  /**
   * Return an isolated store transaction domain for one conformance scenario.
   * The scenario name is stable and may be used to derive a Redis prefix,
   * Durable Object name, Firestore collection prefix, database schema, etc.
   */
  createStore(scenario: string): MaybePromise<UsageStore>;

  /**
   * Wait until a lease with the supplied TTL is authoritatively expired for the
   * tested store. Real stores may sleep; emulator/fake-clock harnesses may advance
   * their store clock instead. Include any configured expiry grace here.
   */
  waitForLeaseExpiry(ttlMs: number, scenario: string): MaybePromise<void>;

  /** Optional cleanup for the isolated scenario domain. */
  cleanup?(scenario: string): MaybePromise<void>;

  /** Lease TTL used by expiry cases. Defaults to 40 ms. */
  leaseTtlMs?: number;

  /** Parallel contenders used by the admission race case. Defaults to 16. */
  concurrency?: number;
}

export interface UsageStoreConformanceCaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface UsageStoreConformanceReport {
  passed: boolean;
  cases: UsageStoreConformanceCaseResult[];
}

export class UsageStoreConformanceError extends Error {
  constructor(public readonly report: UsageStoreConformanceReport) {
    const failed = report.cases.filter(result => !result.passed);
    super(
      `UsageStore conformance failed: ${failed
        .map(result => `${result.name}: ${result.error ?? 'unknown failure'}`)
        .join('; ')}`,
    );
    this.name = 'UsageStoreConformanceError';
  }
}

/**
 * Run the portable, provider-neutral behavioral contract for a UsageStore.
 *
 * Passing this suite means that the public store semantics are compatible. It
 * does not by itself prove persistence/HA, store-time authority, network ACK
 * ambiguity behavior, or platform-specific fault tolerance. Those production
 * safety requirements need adapter-specific evidence in addition to this suite.
 */
export async function runUsageStoreConformance(
  harness: UsageStoreConformanceHarness,
): Promise<UsageStoreConformanceReport> {
  const leaseTtlMs = harness.leaseTtlMs ?? 40;
  const concurrency = harness.concurrency ?? 16;
  assertPositiveInteger(leaseTtlMs, 'leaseTtlMs');
  assertPositiveInteger(concurrency, 'concurrency');

  const cases: UsageStoreConformanceCaseResult[] = [];

  await runCase(harness, cases, 'atomic-multi-budget-denial', async store => {
    const blocking = await store.reserve({
      request: request('seed-blocking'),
      units: 1,
      budgets: [{ key: 'contract:blocking', limit: 1 }],
      ttlMs: 5_000,
    });
    assertAccepted(blocking, 'seed reservation');

    const denied = await store.reserve({
      request: request('must-not-partially-reserve'),
      units: 1,
      budgets: [
        { key: 'contract:free', limit: 1 },
        { key: 'contract:blocking', limit: 1 },
      ],
      ttlMs: 5_000,
    });
    assertDenied(denied, 'quota_exceeded', 'multi-budget denial');

    const probe = await store.reserve({
      request: request('probe-free-budget'),
      units: 1,
      budgets: [{ key: 'contract:free', limit: 1 }],
      ttlMs: 5_000,
    });
    assertAccepted(probe, 'free budget after denied multi-budget reservation');
  });

  await runCase(harness, cases, 'concurrent-admission', async store => {
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        store.reserve({
          request: request(`concurrent-${index}`, `user-${index}`),
          units: 1,
          budgets: [{ key: 'contract:shared-concurrent', limit: 1 }],
          ttlMs: 5_000,
        }),
      ),
    );
    const accepted = results.filter(result => result.accepted);
    const denied = results.filter(result => !result.accepted);
    assert(accepted.length === 1, `expected exactly one concurrent admission, got ${accepted.length}`);
    assert(
      denied.length === concurrency - 1 &&
        denied.every(result => result.reason === 'quota_exceeded'),
      'all losing concurrent admissions must be quota_exceeded',
    );
  });

  await runCase(harness, cases, 'mutable-limit-increase-preserves-usage', async store => {
    const budgetKey = 'contract:mutable-increase';
    const seed = await store.reserve({
      request: request('mutable-increase-seed'),
      units: 2,
      budgets: [{ key: budgetKey, limit: 2 }],
      ttlMs: 5_000,
    });
    assertAccepted(seed, 'initial full bucket');

    const deniedAtOldLimit = await store.reserve({
      request: request('mutable-increase-old-limit'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 2 }],
      ttlMs: 5_000,
    });
    assertDenied(deniedAtOldLimit, 'quota_exceeded', 'admission at old full limit');

    const admittedAtHigherLimit = await store.reserve({
      request: request('mutable-increase-new-limit'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 3 }],
      ttlMs: 5_000,
    });
    assertAccepted(admittedAtHigherLimit, 'admission after limit increase');

    const exhaustedAtHigherLimit = await store.reserve({
      request: request('mutable-increase-exhausted'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 3 }],
      ttlMs: 5_000,
    });
    assertDenied(
      exhaustedAtHigherLimit,
      'quota_exceeded',
      'existing usage must remain counted after limit increase',
    );
  });

  await runCase(harness, cases, 'mutable-limit-decrease-preserves-active-and-used-state', async store => {
    const budgetKey = 'contract:mutable-decrease';
    const active = await store.reserve({
      request: request('mutable-decrease-active'),
      units: 2,
      budgets: [{ key: budgetKey, limit: 3 }],
      ttlMs: 5_000,
    });
    assertAccepted(active, 'active reservation before decrease');

    const deniedWhilePending = await store.reserve({
      request: request('mutable-decrease-pending-denied'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 1 }],
      ttlMs: 5_000,
    });
    assertDenied(
      deniedWhilePending,
      'quota_exceeded',
      'lower limit must not rewrite pending reserved usage',
    );

    await store.markLiable({ reservationId: active.reservation.id });
    const deniedWhileLiable = await store.reserve({
      request: request('mutable-decrease-liable-denied'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 1 }],
      ttlMs: 5_000,
    });
    assertDenied(
      deniedWhileLiable,
      'quota_exceeded',
      'lower limit must not rewrite cost-liable reserved usage',
    );

    await store.settle({
      reservationId: active.reservation.id,
      actualUnits: 2,
      outcome: 'completed-under-lower-limit',
    });

    const deniedAfterSettlement = await store.reserve({
      request: request('mutable-decrease-settled-denied'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 1 }],
      ttlMs: 5_000,
    });
    assertDenied(
      deniedAfterSettlement,
      'quota_exceeded',
      'limit decrease must not refund already-incurred usage',
    );

    const admittedWithRoom = await store.reserve({
      request: request('mutable-decrease-room-restored'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 3 }],
      ttlMs: 5_000,
    });
    assertAccepted(admittedWithRoom, 'raising the effective limit must reuse the same bucket state');
  });

  await runCase(harness, cases, 'mutable-limit-concurrent-policy-views', async store => {
    const budgetKey = 'contract:mutable-concurrent';
    const seed = await store.reserve({
      request: request('mutable-concurrent-seed'),
      units: 1,
      budgets: [{ key: budgetKey, limit: 2 }],
      ttlMs: 5_000,
    });
    assertAccepted(seed, 'seed usage for concurrent policy views');

    const [strictResult, staleHigherResult] = await Promise.all([
      store.reserve({
        request: request('mutable-concurrent-strict'),
        units: 1,
        budgets: [{ key: budgetKey, limit: 1 }],
        ttlMs: 5_000,
      }),
      store.reserve({
        request: request('mutable-concurrent-stale-higher'),
        units: 1,
        budgets: [{ key: budgetKey, limit: 2 }],
        ttlMs: 5_000,
      }),
    ]);

    assertDenied(
      strictResult,
      'quota_exceeded',
      'caller using the stricter limit must deny when usage is already at that limit',
    );
    assertAccepted(
      staleHigherResult,
      'caller still using the higher effective limit remains able to admit within that limit',
    );
  });

  await runCase(harness, cases, 'logical-operation-replay-scope', async store => {
    const base = {
      request: request('same-operation', 'user-1', 'tenant-a', 'read'),
      units: 0,
      budgets: [{ key: 'contract:replay', limit: 1 }] satisfies Budget[],
      ttlMs: 5_000,
    };
    assertAccepted(await store.reserve(base), 'initial logical operation');
    assertDenied(await store.reserve(base), 'duplicate_operation', 'duplicate logical operation');

    assertAccepted(
      await store.reserve({
        ...base,
        request: request('same-operation', 'user-1', 'tenant-b', 'read'),
      }),
      'same operationId in another tenant',
    );
    assertAccepted(
      await store.reserve({
        ...base,
        request: request('same-operation', 'user-1', 'tenant-a', 'write'),
      }),
      'same operationId for another tool',
    );
  });

  await runCase(harness, cases, 'liability-is-idempotent', async store => {
    const admission = await store.reserve({
      request: request('liable-idempotent'),
      units: 1,
      budgets: [{ key: 'contract:liability', limit: 1 }],
      ttlMs: 5_000,
    });
    assertAccepted(admission, 'liability reservation');
    const first = await store.markLiable({ reservationId: admission.reservation.id });
    const second = await store.markLiable({ reservationId: admission.reservation.id });
    assert(first.reservationId === admission.reservation.id, 'first liability result changed reservationId');
    assert(second.reservationId === admission.reservation.id, 'replayed liability result changed reservationId');
    assert(second.expiresAt === first.expiresAt, 'idempotent markLiable replay changed lease expiry');
  });

  await runCase(harness, cases, 'renew-active-lease', async store => {
    const admission = await store.reserve({
      request: request('renew-active'),
      units: 1,
      budgets: [{ key: 'contract:renew', limit: 1 }],
      ttlMs: 1_000,
    });
    assertAccepted(admission, 'renew reservation');
    const renewed = await store.renew({ reservationId: admission.reservation.id, ttlMs: 5_000 });
    assert(renewed.reservationId === admission.reservation.id, 'renew changed reservationId');
    assert(
      renewed.expiresAt >= admission.reservation.expiresAt,
      'renew with a longer TTL moved expiry backwards',
    );
    await store.settle({
      reservationId: admission.reservation.id,
      actualUnits: 1,
      outcome: 'renewed_then_completed',
    });
  });

  await runCase(harness, cases, 'settlement-idempotency-and-conflict', async store => {
    const admission = await store.reserve({
      request: request('settlement-replay'),
      units: 2,
      budgets: [{ key: 'contract:settlement', limit: 2 }],
      ttlMs: 5_000,
    });
    assertAccepted(admission, 'settlement reservation');

    const input = {
      reservationId: admission.reservation.id,
      actualUnits: 1,
      outcome: 'completed',
    };
    const first = await store.settle(input);
    const replay = await store.settle(input);
    assertSameSettlement(first, replay);

    await assertRejects(
      () =>
        store.settle({
          reservationId: admission.reservation.id,
          actualUnits: 0,
          outcome: 'different',
        }),
      'conflicting settlement must fail',
    );
  });

  await runCase(harness, cases, 'invalid-settlement-does-not-corrupt-state', async store => {
    const admission = await store.reserve({
      request: request('invalid-units'),
      units: 1,
      budgets: [{ key: 'contract:invalid-units', limit: 1 }],
      ttlMs: 5_000,
    });
    assertAccepted(admission, 'invalid-units reservation');
    await assertRejects(
      () =>
        store.settle({
          reservationId: admission.reservation.id,
          actualUnits: 2,
          outcome: 'invalid',
        }),
      'actualUnits above reservedUnits must fail',
    );
    const valid = await store.settle({
      reservationId: admission.reservation.id,
      actualUnits: 1,
      outcome: 'valid-after-rejection',
    });
    assert(valid.actualUnits === 1, 'valid settlement failed after invalid attempt');
  });

  await runCase(harness, cases, 'pending-expiry-releases-capacity', async store => {
    const first = await store.reserve({
      request: request('pending-expiry'),
      units: 1,
      budgets: [{ key: 'contract:pending-expiry', limit: 1 }],
      ttlMs: leaseTtlMs,
    });
    assertAccepted(first, 'pending-expiry reservation');
    await harness.waitForLeaseExpiry(leaseTtlMs, 'pending-expiry-releases-capacity');

    const replacement = await store.reserve({
      request: request('pending-expiry-replacement'),
      units: 1,
      budgets: [{ key: 'contract:pending-expiry', limit: 1 }],
      ttlMs: 5_000,
    });
    assertAccepted(replacement, 'replacement after pending expiry');
  });

  await runCase(harness, cases, 'liable-expiry-retains-charge-and-replay-protection', async store => {
    const first = await store.reserve({
      request: request('liable-expiry'),
      units: 1,
      budgets: [{ key: 'contract:liable-expiry', limit: 1 }],
      ttlMs: leaseTtlMs,
    });
    assertAccepted(first, 'liable-expiry reservation');
    await store.markLiable({ reservationId: first.reservation.id });
    await harness.waitForLeaseExpiry(
      leaseTtlMs,
      'liable-expiry-retains-charge-and-replay-protection',
    );

    const another = await store.reserve({
      request: request('after-liable-expiry'),
      units: 1,
      budgets: [{ key: 'contract:liable-expiry', limit: 1 }],
      ttlMs: 5_000,
    });
    assertDenied(another, 'quota_exceeded', 'new operation after liable expiry');

    const replay = await store.reserve({
      request: request('liable-expiry'),
      units: 1,
      budgets: [{ key: 'contract:liable-expiry', limit: 1 }],
      ttlMs: 5_000,
    });
    assertDenied(replay, 'duplicate_operation', 'original operation after liable expiry');
  });

  return {
    passed: cases.every(result => result.passed),
    cases,
  };
}

/** Run the suite and throw a single detailed error if any case fails. */
export async function assertUsageStoreConformance(
  harness: UsageStoreConformanceHarness,
): Promise<UsageStoreConformanceReport> {
  const report = await runUsageStoreConformance(harness);
  if (!report.passed) throw new UsageStoreConformanceError(report);
  return report;
}

async function runCase(
  harness: UsageStoreConformanceHarness,
  results: UsageStoreConformanceCaseResult[],
  name: string,
  body: (store: UsageStore) => Promise<void>,
): Promise<void> {
  try {
    const store = await harness.createStore(name);
    await body(store);
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: errorMessage(error) });
  } finally {
    try {
      await harness.cleanup?.(name);
    } catch (error) {
      results.push({ name: `${name}:cleanup`, passed: false, error: errorMessage(error) });
    }
  }
}

function request(
  operationId: string,
  principalId = 'user-1',
  tenantId = 'tenant-1',
  tool = 'contract-tool',
): UsageRequest {
  return {
    operationId,
    principal: { id: principalId, tenantId },
    tool,
    args: { conformance: true },
  };
}

function assertAccepted(
  result: StoreReserveResult,
  context: string,
): asserts result is Extract<StoreReserveResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected accepted reservation`);
}

function assertDenied(
  result: StoreReserveResult,
  reason: Extract<StoreReserveResult, { accepted: false }>['reason'],
  context: string,
): asserts result is Extract<StoreReserveResult, { accepted: false }> {
  assert(!result.accepted, `${context}: expected denial`);
  assert(result.reason === reason, `${context}: expected ${reason}, got ${result.reason}`);
}

function assertSameSettlement(
  left: Awaited<ReturnType<UsageStore['settle']>>,
  right: Awaited<ReturnType<UsageStore['settle']>>,
): void {
  assert(left.reservationId === right.reservationId, 'idempotent settlement changed reservationId');
  assert(left.reservedUnits === right.reservedUnits, 'idempotent settlement changed reservedUnits');
  assert(left.actualUnits === right.actualUnits, 'idempotent settlement changed actualUnits');
  assert(left.releasedUnits === right.releasedUnits, 'idempotent settlement changed releasedUnits');
  assert(left.outcome === right.outcome, 'idempotent settlement changed outcome');
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
