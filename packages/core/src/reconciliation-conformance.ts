import type {
  OperationReconciliationStore,
  StoreReserveResult,
  StoreVectorReserveResult,
  UsageDimension,
  UsageOperationReconciliationInput,
  UsageRequest,
  VectorOperationReconciliationStore,
  VectorUsageOperationReconciliationInput,
} from './index.js';

type MaybePromise<T> = T | Promise<T>;

export interface OperationReconciliationConformanceHarness {
  createStore(scenario: string): MaybePromise<OperationReconciliationStore>;
  waitForLeaseExpiry(ttlMs: number, scenario: string): MaybePromise<void>;
  cleanup?(scenario: string): MaybePromise<void>;
  leaseTtlMs?: number;
}

export interface OperationReconciliationConformanceCaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface OperationReconciliationConformanceReport {
  passed: boolean;
  cases: OperationReconciliationConformanceCaseResult[];
}

export class OperationReconciliationConformanceError extends Error {
  constructor(public readonly report: OperationReconciliationConformanceReport) {
    const failed = report.cases.filter(result => !result.passed);
    super(
      `Operation reconciliation conformance failed: ${failed
        .map(result => `${result.name}: ${result.error ?? 'unknown failure'}`)
        .join('; ')}`,
    );
    this.name = 'OperationReconciliationConformanceError';
  }
}

/** Portable scalar-only read-only reconciliation contract for optional Store implementations. */
export async function runOperationReconciliationStoreConformance(
  harness: OperationReconciliationConformanceHarness,
): Promise<OperationReconciliationConformanceReport> {
  const ttlMs = harness.leaseTtlMs ?? 40;
  assertPositiveInteger(ttlMs, 'leaseTtlMs');
  const cases: OperationReconciliationConformanceCaseResult[] = [];

  await runCase(harness, cases, 'absent-active-liable-settled', async store => {
    const input = reconciliationInput('lifecycle');
    const absent = await store.reconcileOperation(input);
    assert(absent.status === 'absent', 'new logical operation must be absent');

    const reserved = await store.reserve({ ...input, ttlMs: 5_000 });
    assertAccepted(reserved, 'lifecycle reserve');
    const pending = await store.reconcileOperation(input);
    assert(pending.status === 'active' && pending.state === 'pending', 'pending state not reconciled');
    if (pending.status === 'active') {
      assert(pending.reservation.id === reserved.reservation.id, 'reservation identity changed');
    }

    await store.markLiable({ reservationId: reserved.reservation.id });
    const liable = await store.reconcileOperation(input);
    assert(liable.status === 'active' && liable.state === 'liable', 'liable state not reconciled');

    await store.settle({
      reservationId: reserved.reservation.id,
      actualUnits: 1,
      outcome: 'conformance_completed',
    });
    const settled = await store.reconcileOperation(input);
    assert(
      settled.status === 'settled' && settled.reservedUnits === 1 && settled.actualUnits === 1,
      'settled state not reconciled',
    );
  });

  await runCase(harness, cases, 'expired-read-only', async store => {
    const input = reconciliationInput('expired');
    const reserved = await store.reserve({ ...input, ttlMs });
    assertAccepted(reserved, 'expiring reserve');
    await harness.waitForLeaseExpiry(ttlMs, 'expired-read-only');

    const first = await store.reconcileOperation(input);
    const second = await store.reconcileOperation(input);
    assert(first.status === 'expired' && first.state === 'pending', 'expired pending state not reported');
    assert(second.status === 'expired' && second.state === 'pending', 'reconciliation mutated expired state');
  });

  await runCase(harness, cases, 'mismatched-quote-fails-closed', async store => {
    const input = reconciliationInput('mismatch');
    const reserved = await store.reserve({ ...input, ttlMs: 5_000 });
    assertAccepted(reserved, 'mismatch seed reserve');
    await assertRejects(
      () => store.reconcileOperation({ ...input, units: 2 }),
      'mismatched reserved units must fail closed',
    );
    await assertRejects(
      () =>
        store.reconcileOperation({
          ...input,
          budgets: [{ key: 'contract:reconcile:other', limit: 10 }],
        }),
      'mismatched budgets must fail closed',
    );
  });

  return { passed: cases.every(result => result.passed), cases };
}


export interface VectorOperationReconciliationConformanceHarness {
  createStore(scenario: string): MaybePromise<VectorOperationReconciliationStore>;
  waitForLeaseExpiry(ttlMs: number, scenario: string): MaybePromise<void>;
  cleanup?(scenario: string): MaybePromise<void>;
  leaseTtlMs?: number;
}

export type VectorOperationReconciliationConformanceReport = OperationReconciliationConformanceReport;

/** Portable read-only initial-vector-reserve reconciliation contract. */
export async function runVectorOperationReconciliationStoreConformance(
  harness: VectorOperationReconciliationConformanceHarness,
): Promise<VectorOperationReconciliationConformanceReport> {
  const ttlMs = harness.leaseTtlMs ?? 40;
  assertPositiveInteger(ttlMs, 'leaseTtlMs');
  const cases: OperationReconciliationConformanceCaseResult[] = [];

  await runVectorCase(harness, cases, 'vector-absent-active-liable-settled', async store => {
    const input = vectorReconciliationInput('lifecycle');
    assert((await store.reconcileVectorOperation(input)).status === 'absent', 'new vector operation must be absent');
    const reserved = await store.reserveVector({ ...input, ttlMs: 5_000 });
    assertVectorAccepted(reserved, 'vector lifecycle reserve');
    const pending = await store.reconcileVectorOperation(input);
    assert(pending.status === 'active' && pending.state === 'pending', 'vector pending state not reconciled');
    await store.markLiable({ reservationId: reserved.reservation.id });
    const liable = await store.reconcileVectorOperation(input);
    assert(liable.status === 'active' && liable.state === 'liable', 'vector liable state not reconciled');
    await store.settleVector({
      reservationId: reserved.reservation.id,
      actualByDimension: input.dimensions.map(dimension => ({ key: dimension.key, actualUnits: dimension.units })),
      outcome: 'conformance_completed',
    });
    const settled = await store.reconcileVectorOperation(input);
    assert(settled.status === 'settled', 'vector settled state not reconciled');
    if (settled.status === 'settled') {
      assert(settled.reservedByDimension.length === input.dimensions.length, 'settled vector reserved topology changed');
      assert(settled.actualByDimension.length === input.dimensions.length, 'settled vector actual topology changed');
    }
  });

  await runVectorCase(harness, cases, 'vector-expired-read-only', async store => {
    const input = vectorReconciliationInput('expired');
    const reserved = await store.reserveVector({ ...input, ttlMs });
    assertVectorAccepted(reserved, 'expiring vector reserve');
    await harness.waitForLeaseExpiry(ttlMs, 'vector-expired-read-only');
    const first = await store.reconcileVectorOperation(input);
    const second = await store.reconcileVectorOperation(input);
    assert(first.status === 'expired' && first.state === 'pending', 'expired vector pending state not reported');
    assert(second.status === 'expired' && second.state === 'pending', 'vector reconciliation mutated expired state');
  });

  await runVectorCase(harness, cases, 'vector-topology-mismatch-fails-closed', async store => {
    const input = vectorReconciliationInput('mismatch');
    const reserved = await store.reserveVector({ ...input, ttlMs: 5_000 });
    assertVectorAccepted(reserved, 'vector mismatch seed reserve');
    await assertRejects(() => store.reconcileVectorOperation({
      ...input,
      dimensions: [{ ...input.dimensions[0]!, units: input.dimensions[0]!.units + 1 }, input.dimensions[1]!],
    }), 'mismatched vector units must fail closed');
    await assertRejects(() => store.reconcileVectorOperation({
      ...input,
      dimensions: [{ ...input.dimensions[0]!, budgets: [{ key: 'contract:vector:other', limit: 10 }] }, input.dimensions[1]!],
    }), 'mismatched vector budgets must fail closed');
  });

  return { passed: cases.every(result => result.passed), cases };
}

export async function assertVectorOperationReconciliationStoreConformance(
  harness: VectorOperationReconciliationConformanceHarness,
): Promise<void> {
  const report = await runVectorOperationReconciliationStoreConformance(harness);
  if (!report.passed) throw new OperationReconciliationConformanceError(report);
}

export async function assertOperationReconciliationStoreConformance(
  harness: OperationReconciliationConformanceHarness,
): Promise<void> {
  const report = await runOperationReconciliationStoreConformance(harness);
  if (!report.passed) throw new OperationReconciliationConformanceError(report);
}

async function runCase(
  harness: OperationReconciliationConformanceHarness,
  results: OperationReconciliationConformanceCaseResult[],
  name: string,
  body: (store: OperationReconciliationStore) => Promise<void>,
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


async function runVectorCase(
  harness: VectorOperationReconciliationConformanceHarness,
  results: OperationReconciliationConformanceCaseResult[],
  name: string,
  body: (store: VectorOperationReconciliationStore) => Promise<void>,
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

function vectorReconciliationInput(operationId: string): VectorUsageOperationReconciliationInput {
  const dimensions: UsageDimension[] = [
    { key: 'requests', units: 1, budgets: [{ key: `contract:vector:${operationId}:requests`, limit: 10 }] },
    { key: 'tokens', units: 3, budgets: [{ key: `contract:vector:${operationId}:tokens`, limit: 100 }] },
  ];
  return { request: request(`vector-${operationId}`), dimensions };
}

function assertVectorAccepted(
  result: StoreVectorReserveResult,
  context: string,
): asserts result is Extract<StoreVectorReserveResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected accepted reservation`);
}

function reconciliationInput(operationId: string): UsageOperationReconciliationInput {
  return {
    request: request(operationId),
    units: 1,
    budgets: [{ key: `contract:reconcile:${operationId}`, limit: 10 }],
  };
}

function request(operationId: string): UsageRequest {
  return {
    operationId,
    principal: { id: 'user-1', tenantId: 'tenant-1' },
    tool: 'contract-tool',
    args: { conformance: true },
  };
}

function assertAccepted(
  result: StoreReserveResult,
  context: string,
): asserts result is Extract<StoreReserveResult, { accepted: true }> {
  assert(result.accepted, `${context}: expected accepted reservation`);
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
