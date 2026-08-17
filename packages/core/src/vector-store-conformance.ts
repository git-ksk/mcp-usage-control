import type {
  StoreReserveResult,
  StoreVectorGrowResult,
  StoreVectorReserveResult,
  UsageDimension,
  UsageDimensionGrowth,
  UsageRequest,
  UsageStore,
  VectorUsageStore,
} from './index.js';
import type {
  UsageStoreConformanceCaseResult,
  UsageStoreConformanceHarness,
  UsageStoreConformanceReport,
} from './store-conformance.js';

/** Portable proof suite for the optional atomic heterogeneous usage capability. */
export async function runVectorUsageStoreConformance(
  harness: UsageStoreConformanceHarness,
): Promise<UsageStoreConformanceReport> {
  const ttlMs = harness.leaseTtlMs ?? 40;
  const concurrency = harness.concurrency ?? 8;
  positive(ttlMs, 'leaseTtlMs');
  positive(concurrency, 'concurrency');
  const cases: UsageStoreConformanceCaseResult[] = [];

  await runCase(harness, cases, 'vector-atomic-denial', async store => {
    const blocker = await store.reserve({
      request: request('blocker', 'blocker'),
      units: 1,
      budgets: [{ key: 'vector:blocked', limit: 1 }],
      ttlMs: 5_000,
    });
    scalarAccepted(blocker, 'blocker');
    const denied = await store.reserveVector({
      request: request('denied'),
      dimensions: [
        { key: 'requests', units: 1, budgets: [{ key: 'vector:free', limit: 1 }] },
        { key: 'tokens', units: 7, budgets: [{ key: 'vector:blocked', limit: 1 }] },
      ],
      ttlMs: 5_000,
    });
    vectorDenied(denied, 'atomic denial');
    assert(denied.limitingDimensionKey === 'tokens', 'wrong limiting dimension');
    const probe = await store.reserve({
      request: request('probe'),
      units: 1,
      budgets: [{ key: 'vector:free', limit: 1 }],
      ttlMs: 5_000,
    });
    scalarAccepted(probe, 'denial partially consumed free dimension');
  });

  await runCase(harness, cases, 'vector-concurrent-admission', async store => {
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        store.reserveVector({
          request: request(`concurrent-${index}`, `u-${index}`),
          dimensions: [
            { key: 'requests', units: 1, budgets: [{ key: 'vector:shared', limit: 1 }] },
            { key: 'tokens', units: 3, budgets: [{ key: `vector:tok:${index}`, limit: 3 }] },
          ],
          ttlMs: 5_000,
        }),
      ),
    );
    assert(results.filter(result => result.accepted).length === 1, 'vector admission oversubscribed');
    assert(
      results.filter(result => !result.accepted).every(result => result.reason === 'quota_exceeded'),
      'losers must be quota_exceeded',
    );
  });

  await runCase(harness, cases, 'vector-scalar-operation-collision', async store => {
    await reserveVector(store, 'same-op', dimensions('collision'));
    const scalar = await store.reserve({
      request: request('same-op'),
      units: 0,
      budgets: [{ key: 'vector:collision:scalar', limit: 1 }],
      ttlMs: 5_000,
    });
    scalarDenied(scalar, 'duplicate_operation', 'scalar/vector replay domains diverged');
  });

  await runCase(harness, cases, 'vector-growth-replay-concurrency', async store => {
    const admission = await reserveVector(store, 'growth', dimensions('growth', 2, 20));
    const cursor = vectorCursor(admission);
    const input = {
      reservationId: admission.reservation.id,
      incrementId: 'inc-1',
      expectedGrowthCursor: cursor,
      dimensions: growth('growth', 0, 5, 2, 20),
    } as const;
    const first = await store.growVectorReservation(input);
    growthAccepted(first, 'first growth');
    assertReserved(first, 'requests', 1);
    assertReserved(first, 'tokens', 10);
    const replay = await store.growVectorReservation(input);
    growthAccepted(replay, 'growth replay');
    assert(replay.replayed, 'exact growth retry did not replay');
    await rejects(
      () => store.growVectorReservation({ ...input, dimensions: growth('growth', 0, 6, 2, 20) }),
      'conflicting replay must fail',
    );

    const concurrent = await reserveVector(
      store,
      'growth-concurrent',
      dimensions('growth-concurrent', 3, 30),
    );
    const concurrentCursor = vectorCursor(concurrent);
    const attempts = await Promise.allSettled([
      store.growVectorReservation({
        reservationId: concurrent.reservation.id,
        incrementId: 'a',
        expectedGrowthCursor: concurrentCursor,
        dimensions: growth('growth-concurrent', 1, 1, 3, 30),
      }),
      store.growVectorReservation({
        reservationId: concurrent.reservation.id,
        incrementId: 'b',
        expectedGrowthCursor: concurrentCursor,
        dimensions: growth('growth-concurrent', 1, 1, 3, 30),
      }),
    ]);
    assert(attempts.filter(result => result.status === 'fulfilled').length === 1, 'one growth must win');
    assert(attempts.filter(result => result.status === 'rejected').length === 1, 'stale growth must fail');
  });

  await runCase(harness, cases, 'vector-growth-denial-atomic', async store => {
    const admission = await reserveVector(store, 'growth-denial', [
      { key: 'requests', units: 1, budgets: [{ key: 'vector:gd:req', limit: 2 }] },
      { key: 'tokens', units: 4, budgets: [{ key: 'vector:gd:tok', limit: 4 }] },
    ]);
    const cursor = vectorCursor(admission);
    const input = {
      reservationId: admission.reservation.id,
      incrementId: 'denied',
      expectedGrowthCursor: cursor,
      dimensions: [
        { key: 'requests', additionalUnits: 1, budgets: [{ key: 'vector:gd:req', limit: 2 }] },
        { key: 'tokens', additionalUnits: 1, budgets: [{ key: 'vector:gd:tok', limit: 4 }] },
      ],
    } as const;
    const denied = await store.growVectorReservation(input);
    growthDenied(denied, 'growth denial');
    assert(denied.growthCursor !== cursor, 'denial must rotate cursor');
    const replay = await store.growVectorReservation(input);
    growthDenied(replay, 'growth denial replay');
    assert(replay.replayed, 'denied retry did not replay');
    const probe = await store.reserve({
      request: request('growth-denial-probe'),
      units: 1,
      budgets: [{ key: 'vector:gd:req', limit: 2 }],
      ttlMs: 5_000,
    });
    scalarAccepted(probe, 'denied growth partially consumed request dimension');
  });

  await runCase(harness, cases, 'vector-pending-liable-expiry', async store => {
    await reserveVector(store, 'pending-expiry', dimensions('pending-expiry', 1, 5), ttlMs);
    await harness.waitForLeaseExpiry(ttlMs, 'vector-pending-liable-expiry');
    await reserveVector(store, 'pending-replacement', dimensions('pending-expiry', 1, 5));

    const liable = await reserveVector(store, 'liable-expiry', dimensions('liable-expiry', 1, 5), ttlMs);
    await store.markLiable({ reservationId: liable.reservation.id });
    await harness.waitForLeaseExpiry(ttlMs, 'vector-pending-liable-expiry');
    const denied = await store.reserveVector({
      request: request('liable-replacement'),
      dimensions: dimensions('liable-expiry', 1, 5),
      ttlMs: 5_000,
    });
    vectorDenied(denied, 'liable expiry must retain vector capacity');
  });

  await runCase(harness, cases, 'vector-settlement-bound-replay-terminal', async store => {
    const admission = await reserveVector(store, 'settlement', dimensions('settlement', 2, 10));
    const grown = await store.growVectorReservation({
      reservationId: admission.reservation.id,
      incrementId: 'settle-grow',
      expectedGrowthCursor: vectorCursor(admission),
      dimensions: growth('settlement', 1, 3, 2, 10),
    });
    growthAccepted(grown, 'settlement growth');
    await rejects(
      () =>
        store.settleVector({
          reservationId: admission.reservation.id,
          actualByDimension: [
            { key: 'requests', actualUnits: 3 },
            { key: 'tokens', actualUnits: 8 },
          ],
          outcome: 'invalid',
        }),
      'actual above one vector dimension must fail',
    );
    const input = {
      reservationId: admission.reservation.id,
      actualByDimension: [
        { key: 'requests', actualUnits: 2 },
        { key: 'tokens', actualUnits: 7 },
      ],
      outcome: 'completed',
    } as const;
    const first = await store.settleVector(input);
    const replay = await store.settleVector(input);
    assert(JSON.stringify(first) === JSON.stringify(replay), 'vector settlement replay changed result');
    await rejects(
      () =>
        store.growVectorReservation({
          reservationId: admission.reservation.id,
          incrementId: 'after-settlement',
          expectedGrowthCursor: grown.growthCursor,
          dimensions: growth('settlement', 0, 1, 2, 10),
        }),
      'growth after settlement must fail',
    );
  });

  await runCase(harness, cases, 'vector-growth-vs-settle-race', async store => {
    const admission = await reserveVector(store, 'race', dimensions('race', 2, 10));
    const results = await Promise.allSettled([
      store.growVectorReservation({
        reservationId: admission.reservation.id,
        incrementId: 'race-growth',
        expectedGrowthCursor: vectorCursor(admission),
        dimensions: growth('race', 1, 1, 2, 10),
      }),
      store.settleVector({
        reservationId: admission.reservation.id,
        actualByDimension: [
          { key: 'requests', actualUnits: 1 },
          { key: 'tokens', actualUnits: 5 },
        ],
        outcome: 'race',
      }),
    ]);
    assert(results[1]!.status === 'fulfilled', 'settlement side of race must complete');
    if (results[0]!.status === 'fulfilled' && results[1]!.status === 'fulfilled') {
      growthAccepted(results[0]!.value, 'race growth');
      const requests = results[1]!.value.dimensions.find(item => item.key === 'requests');
      assert(requests?.reservedUnits === 2, 'settlement did not observe prior growth');
    }
  });

  return { passed: cases.every(result => result.passed), cases };
}

async function runCase(
  harness: UsageStoreConformanceHarness,
  cases: UsageStoreConformanceCaseResult[],
  name: string,
  body: (store: VectorUsageStore) => Promise<void>,
): Promise<void> {
  try {
    const store = await harness.createStore(name);
    if (!isVectorStore(store)) throw new Error('Store does not support atomic vector usage');
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

function isVectorStore(store: UsageStore): store is VectorUsageStore {
  const candidate = store as Partial<VectorUsageStore>;
  return (
    typeof candidate.reserveVector === 'function' &&
    typeof candidate.growVectorReservation === 'function' &&
    typeof candidate.settleVector === 'function'
  );
}

async function reserveVector(
  store: VectorUsageStore,
  operationId: string,
  vector: readonly UsageDimension[],
  ttlMs = 5_000,
): Promise<Extract<StoreVectorReserveResult, { accepted: true }>> {
  const result = await store.reserveVector({ request: request(operationId), dimensions: vector, ttlMs });
  vectorAccepted(result, operationId);
  vectorCursor(result);
  return result;
}

function dimensions(suffix: string, requestLimit = 10, tokenLimit = 50): UsageDimension[] {
  return [
    { key: 'requests', units: 1, budgets: [{ key: `vector:${suffix}:requests`, limit: requestLimit }] },
    { key: 'tokens', units: 5, budgets: [{ key: `vector:${suffix}:tokens`, limit: tokenLimit }] },
  ];
}

function growth(
  suffix: string,
  requestUnits: number,
  tokenUnits: number,
  requestLimit = 10,
  tokenLimit = 50,
): UsageDimensionGrowth[] {
  return [
    {
      key: 'requests',
      additionalUnits: requestUnits,
      budgets: [{ key: `vector:${suffix}:requests`, limit: requestLimit }],
    },
    {
      key: 'tokens',
      additionalUnits: tokenUnits,
      budgets: [{ key: `vector:${suffix}:tokens`, limit: tokenLimit }],
    },
  ];
}

function request(operationId: string, principalId = 'user-1'): UsageRequest {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-1' },
    tool: 'vector-conformance',
    args: { conformance: true },
  };
}

function vectorCursor(result: Extract<StoreVectorReserveResult, { accepted: true }>): string {
  const cursor = result.reservation.growthCursor;
  assert(typeof cursor === 'string' && cursor.length > 0, 'vector reservation missing growthCursor');
  return cursor;
}

function assertReserved(result: Extract<StoreVectorGrowResult, { accepted: true }>, key: string, expected: number): void {
  assert(result.reservedByDimension.find(item => item.key === key)?.reservedUnits === expected, `wrong reserved ${key}`);
}

function scalarAccepted(result: StoreReserveResult, context: string): asserts result is Extract<StoreReserveResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected scalar admission`);
}
function scalarDenied(result: StoreReserveResult, reason: Extract<StoreReserveResult, { accepted: false }>['reason'], context: string): void {
  assert(!result.accepted && result.reason === reason, `${context}: expected ${reason}`);
}
function vectorAccepted(result: StoreVectorReserveResult, context: string): asserts result is Extract<StoreVectorReserveResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected vector admission`);
}
function vectorDenied(result: StoreVectorReserveResult, context: string): asserts result is Extract<StoreVectorReserveResult, { accepted: false }> {
  assert(!result.accepted && result.reason === 'quota_exceeded', `${context}: expected quota denial`);
}
function growthAccepted(result: StoreVectorGrowResult, context: string): asserts result is Extract<StoreVectorGrowResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected vector growth`);
}
function growthDenied(result: StoreVectorGrowResult, context: string): asserts result is Extract<StoreVectorGrowResult, { accepted: false }> {
  assert(!result.accepted && result.reason === 'quota_exceeded', `${context}: expected vector growth denial`);
}
async function rejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try { await action(); } catch { return; }
  throw new Error(message);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
