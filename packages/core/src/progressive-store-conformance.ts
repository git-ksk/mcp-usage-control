import type {
  Budget,
  ProgressiveUsageStore,
  StoreGrowResult,
  StoreReserveResult,
  UsageRequest,
  UsageStore,
} from './index.js';
import type {
  UsageStoreConformanceCaseResult,
  UsageStoreConformanceHarness,
  UsageStoreConformanceReport,
} from './store-conformance.js';

/** Portable proof suite for the optional progressive reservation growth capability. */
export async function runProgressiveUsageStoreConformance(
  harness: UsageStoreConformanceHarness,
): Promise<UsageStoreConformanceReport> {
  const ttlMs = harness.leaseTtlMs ?? 40;
  assertPositiveInteger(ttlMs, 'leaseTtlMs');
  const cases: UsageStoreConformanceCaseResult[] = [];

  await runCase(harness, cases, 'growth-success-replay-conflict', async store => {
    const admission = await reserveGrowable(store, 'growth-success', 1, [
      { key: 'growth:success', limit: 4 },
    ]);
    const cursor = growthCursor(admission);
    const firstInput = {
      reservationId: admission.reservation.id,
      incrementId: 'inc-1',
      expectedGrowthCursor: cursor,
      additionalUnits: 1,
      budgets: [{ key: 'growth:success', limit: 4 }],
    } as const;
    const first = await store.growReservation(firstInput);
    assertAcceptedGrowth(first, 'first growth');
    assert(first.reservedUnits === 2, 'first growth total mismatch');

    const replay = await store.growReservation(firstInput);
    assertAcceptedGrowth(replay, 'growth replay');
    assert(replay.replayed, 'duplicate increment must replay');
    assert(replay.reservedUnits === 2, 'duplicate increment reserved twice');

    await assertRejects(
      () => store.growReservation({ ...firstInput, additionalUnits: 2 }),
      'same incrementId with conflicting parameters must fail',
    );

    const second = await store.growReservation({
      reservationId: admission.reservation.id,
      incrementId: 'inc-2',
      expectedGrowthCursor: first.growthCursor,
      additionalUnits: 2,
      budgets: [{ key: 'growth:success', limit: 4 }],
    });
    assertAcceptedGrowth(second, 'second growth');
    assert(second.reservedUnits === 4, 'sequential growth total mismatch');
  });

  await runCase(harness, cases, 'growth-concurrency', async store => {
    const same = await reserveGrowable(store, 'growth-concurrent-same', 1, [
      { key: 'growth:concurrent-same', limit: 2 },
    ]);
    const sameInput = {
      reservationId: same.reservation.id,
      incrementId: 'same-inc',
      expectedGrowthCursor: growthCursor(same),
      additionalUnits: 1,
      budgets: [{ key: 'growth:concurrent-same', limit: 2 }],
    } as const;
    const sameResults = await Promise.all([
      store.growReservation(sameInput),
      store.growReservation(sameInput),
    ]);
    sameResults.forEach(result => assertAcceptedGrowth(result, 'concurrent same increment'));
    assert(sameResults.filter(result => result.replayed).length === 1, 'same increment committed more than once');

    const distinct = await reserveGrowable(store, 'growth-concurrent-distinct', 1, [
      { key: 'growth:concurrent-distinct', limit: 3 },
    ]);
    const cursor = growthCursor(distinct);
    const distinctResults = await Promise.allSettled([
      store.growReservation({
        reservationId: distinct.reservation.id,
        incrementId: 'inc-a',
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:concurrent-distinct', limit: 3 }],
      }),
      store.growReservation({
        reservationId: distinct.reservation.id,
        incrementId: 'inc-b',
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:concurrent-distinct', limit: 3 }],
      }),
    ]);
    assert(distinctResults.filter(result => result.status === 'fulfilled').length === 1, 'one distinct increment must win');
    assert(distinctResults.filter(result => result.status === 'rejected').length === 1, 'stale distinct increment must fail closed');
  });

  await runCase(harness, cases, 'growth-denial-cursor-and-atomic-budgets', async store => {
    const admission = await reserveGrowable(store, 'growth-atomic', 1, [
      { key: 'growth:atomic-free', limit: 3 },
      { key: 'growth:atomic-blocked', limit: 2 },
    ]);
    const blocker = await store.reserve({
      request: request('growth-blocker', 'blocker'),
      units: 1,
      budgets: [{ key: 'growth:atomic-blocked', limit: 2 }],
      ttlMs: 5_000,
    });
    assertReserveAccepted(blocker, 'blocking reservation');

    const cursor = growthCursor(admission);
    const deniedInput = {
      reservationId: admission.reservation.id,
      incrementId: 'denied-inc',
      expectedGrowthCursor: cursor,
      additionalUnits: 1,
      budgets: [
        { key: 'growth:atomic-free', limit: 3 },
        { key: 'growth:atomic-blocked', limit: 2 },
      ],
    } as const;
    const denied = await store.growReservation(deniedInput);
    assertDeniedGrowth(denied, 'growth denial');
    assert(denied.growthCursor !== cursor, 'authoritative denial must rotate cursor');
    const replay = await store.growReservation(deniedInput);
    assertDeniedGrowth(replay, 'growth denial replay');
    assert(replay.replayed, 'denied growth retry must replay');

    await assertRejects(
      () =>
        store.growReservation({
          ...deniedInput,
          incrementId: 'new-id-on-stale-cursor',
        }),
      'different increment on stale cursor must fail closed',
    );

    const freeProbe = await store.reserve({
      request: request('growth-free-probe'),
      units: 2,
      budgets: [{ key: 'growth:atomic-free', limit: 3 }],
      ttlMs: 5_000,
    });
    assertReserveAccepted(freeProbe, 'denied multi-budget growth must not partially reserve');
  });

  await runCase(harness, cases, 'growth-pending-and-liable-expiry', async store => {
    const pending = await reserveGrowable(
      store,
      'growth-pending-expiry',
      1,
      [{ key: 'growth:pending-expiry', limit: 3 }],
      ttlMs,
    );
    const pendingGrowth = await store.growReservation({
      reservationId: pending.reservation.id,
      incrementId: 'pending-inc',
      expectedGrowthCursor: growthCursor(pending),
      additionalUnits: 2,
      budgets: [{ key: 'growth:pending-expiry', limit: 3 }],
    });
    assertAcceptedGrowth(pendingGrowth, 'pending growth');
    const pendingCursor = pendingGrowth.growthCursor;
    await harness.waitForLeaseExpiry(ttlMs, 'growth-pending-and-liable-expiry');
    await assertRejects(
      () =>
        store.growReservation({
          reservationId: pending.reservation.id,
          incrementId: 'pending-inc',
          expectedGrowthCursor: growthCursor(pending),
          additionalUnits: 2,
          budgets: [{ key: 'growth:pending-expiry', limit: 3 }],
        }),
      'growth replay after expiry must fail closed',
    );
    assert(typeof pendingCursor === 'string' && pendingCursor.length > 0, 'growth cursor missing');
    const pendingReplacement = await store.reserve({
      request: request('growth-pending-replacement'),
      units: 3,
      budgets: [{ key: 'growth:pending-expiry', limit: 3 }],
      ttlMs: 5_000,
    });
    assertReserveAccepted(pendingReplacement, 'pending grown total must be released');

    const liable = await reserveGrowable(
      store,
      'growth-liable-expiry',
      1,
      [{ key: 'growth:liable-expiry', limit: 2 }],
      ttlMs,
    );
    await store.markLiable({ reservationId: liable.reservation.id });
    const liableGrowth = await store.growReservation({
      reservationId: liable.reservation.id,
      incrementId: 'liable-inc',
      expectedGrowthCursor: growthCursor(liable),
      additionalUnits: 1,
      budgets: [{ key: 'growth:liable-expiry', limit: 2 }],
    });
    assertAcceptedGrowth(liableGrowth, 'liable growth');
    await harness.waitForLeaseExpiry(ttlMs, 'growth-pending-and-liable-expiry');
    const liableReplacement = await store.reserve({
      request: request('growth-liable-replacement'),
      units: 1,
      budgets: [{ key: 'growth:liable-expiry', limit: 2 }],
      ttlMs: 5_000,
    });
    assertReserveDenied(liableReplacement, 'quota_exceeded', 'liable grown total must be retained');
  });

  await runCase(harness, cases, 'growth-vs-reserve-race', async store => {
    const admission = await reserveGrowable(store, 'growth-vs-reserve', 1, [
      { key: 'growth:vs-reserve', limit: 2 },
    ]);
    const [growth, competingReserve] = await Promise.all([
      store.growReservation({
        reservationId: admission.reservation.id,
        incrementId: 'growth-vs-reserve-inc',
        expectedGrowthCursor: growthCursor(admission),
        additionalUnits: 1,
        budgets: [{ key: 'growth:vs-reserve', limit: 2 }],
      }),
      store.reserve({
        request: request('growth-vs-reserve-competitor', 'user-2'),
        units: 1,
        budgets: [{ key: 'growth:vs-reserve', limit: 2 }],
        ttlMs: 5_000,
      }),
    ]);
    const admittedCount = Number(growth.accepted) + Number(competingReserve.accepted);
    assert(admittedCount === 1, 'reserve/growth race oversubscribed or denied both contenders');
  });

  await runCase(harness, cases, 'growth-vs-expiry-recovery-race', async store => {
    const admission = await reserveGrowable(
      store,
      'growth-vs-recovery',
      1,
      [{ key: 'growth:vs-recovery', limit: 1 }],
      ttlMs,
    );
    const cursor = growthCursor(admission);
    await harness.waitForLeaseExpiry(ttlMs, 'growth-vs-expiry-recovery-race');

    const [growth, replacement] = await Promise.allSettled([
      store.growReservation({
        reservationId: admission.reservation.id,
        incrementId: 'expired-growth',
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:vs-recovery', limit: 2 }],
      }),
      store.reserve({
        request: request('growth-vs-recovery-replacement', 'user-2'),
        units: 1,
        budgets: [{ key: 'growth:vs-recovery', limit: 1 }],
        ttlMs: 5_000,
      }),
    ]);
    assert(growth.status === 'rejected', 'expired growth must fail closed during recovery race');
    assert(replacement.status === 'fulfilled', 'replacement reserve must complete after pending expiry');
    if (replacement.status === 'fulfilled') {
      assertReserveAccepted(replacement.value, 'replacement after expiry/recovery race');
    }
  });

  await runCase(harness, cases, 'growth-settlement-bound-and-terminal-state', async store => {
    const admission = await reserveGrowable(store, 'growth-settlement', 1, [
      { key: 'growth:settlement', limit: 3 },
    ]);
    const grown = await store.growReservation({
      reservationId: admission.reservation.id,
      incrementId: 'settlement-inc',
      expectedGrowthCursor: growthCursor(admission),
      additionalUnits: 2,
      budgets: [{ key: 'growth:settlement', limit: 3 }],
    });
    assertAcceptedGrowth(grown, 'settlement growth');
    await assertRejects(
      () => store.settle({ reservationId: admission.reservation.id, actualUnits: 4, outcome: 'invalid' }),
      'settlement above grown total must fail',
    );
    const settled = await store.settle({
      reservationId: admission.reservation.id,
      actualUnits: 3,
      outcome: 'exact',
    });
    assert(settled.reservedUnits === 3 && settled.actualUnits === 3, 'exact grown settlement failed');
    await assertRejects(
      () =>
        store.growReservation({
          reservationId: admission.reservation.id,
          incrementId: 'after-settle',
          expectedGrowthCursor: grown.growthCursor,
          additionalUnits: 1,
          budgets: [{ key: 'growth:settlement', limit: 4 }],
        }),
      'new growth after settlement must fail',
    );
  });

  await runCase(harness, cases, 'growth-vs-settle-race', async store => {
    const admission = await reserveGrowable(store, 'growth-settle-race', 1, [
      { key: 'growth:settle-race', limit: 2 },
    ]);
    const results = await Promise.allSettled([
      store.growReservation({
        reservationId: admission.reservation.id,
        incrementId: 'race-inc',
        expectedGrowthCursor: growthCursor(admission),
        additionalUnits: 1,
        budgets: [{ key: 'growth:settle-race', limit: 2 }],
      }),
      store.settle({ reservationId: admission.reservation.id, actualUnits: 1, outcome: 'race' }),
    ]);
    assert(results[1]!.status === 'fulfilled', 'settlement side of race must complete');
    if (results[0]!.status === 'fulfilled' && results[1]!.status === 'fulfilled') {
      assertAcceptedGrowth(results[0]!.value, 'growth side of race');
      assert(results[1]!.value.reservedUnits === 2, 'settlement did not observe prior growth commit');
    }
  });

  return { passed: cases.every(result => result.passed), cases };
}

async function runCase(
  harness: UsageStoreConformanceHarness,
  cases: UsageStoreConformanceCaseResult[],
  name: string,
  body: (store: ProgressiveUsageStore) => Promise<void>,
): Promise<void> {
  try {
    const store = await harness.createStore(name);
    if (!isProgressiveStore(store)) throw new Error('Store does not support progressive reservation growth');
    await body(store);
    cases.push({ name, passed: true });
  } catch (error) {
    cases.push({ name, passed: false, error: errorMessage(error) });
  } finally {
    try {
      await harness.cleanup?.(name);
    } catch (error) {
      cases.push({ name: `${name}:cleanup`, passed: false, error: errorMessage(error) });
    }
  }
}

function isProgressiveStore(store: UsageStore): store is ProgressiveUsageStore {
  return typeof (store as Partial<ProgressiveUsageStore>).growReservation === 'function';
}

async function reserveGrowable(
  store: ProgressiveUsageStore,
  operationId: string,
  units: number,
  budgets: readonly Budget[],
  ttlMs = 5_000,
): Promise<Extract<StoreReserveResult, { accepted: true }>> {
  const result = await store.reserve({ request: request(operationId), units, budgets, ttlMs });
  assertReserveAccepted(result, `${operationId} reservation`);
  growthCursor(result);
  return result;
}

function growthCursor(result: Extract<StoreReserveResult, { accepted: true }>): string {
  const cursor = result.reservation.growthCursor;
  assert(typeof cursor === 'string' && cursor.length > 0, 'growable reservation missing growthCursor');
  return cursor;
}

function request(operationId: string, principalId = 'user-1'): UsageRequest {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-1' },
    tool: 'growth-conformance',
    args: { conformance: true },
  };
}

function assertReserveAccepted(
  result: StoreReserveResult,
  context: string,
): asserts result is Extract<StoreReserveResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected accepted reservation`);
}

function assertReserveDenied(
  result: StoreReserveResult,
  reason: Extract<StoreReserveResult, { accepted: false }>['reason'],
  context: string,
): asserts result is Extract<StoreReserveResult, { accepted: false }> {
  assert(!result.accepted && result.reason === reason, `${context}: expected ${reason}`);
}

function assertAcceptedGrowth(
  result: StoreGrowResult,
  context: string,
): asserts result is Extract<StoreGrowResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected accepted growth`);
}

function assertDeniedGrowth(
  result: StoreGrowResult,
  context: string,
): asserts result is Extract<StoreGrowResult, { accepted: false }> {
  assert(!result.accepted && result.reason === 'quota_exceeded', `${context}: expected quota denial`);
}

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
