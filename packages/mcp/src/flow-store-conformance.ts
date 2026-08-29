import type {
  McpUsageFlowBinding,
  McpUsageFlowRecord,
  McpUsageFlowStore,
} from './index.js';

type MaybePromise<T> = T | Promise<T>;

export interface McpUsageFlowStoreConformanceHarness {
  /** Return an isolated flow-store domain for one scenario. */
  createStore(scenario: string): MaybePromise<McpUsageFlowStore>;

  /** Wait until a flow with the supplied TTL is authoritatively expired. */
  waitForFlowExpiry(ttlMs: number, scenario: string): MaybePromise<void>;

  /** Optional cleanup for the isolated scenario domain. */
  cleanup?(scenario: string): MaybePromise<void>;

  /** Flow lifetime used by the expiry case. Defaults to 40 ms. */
  flowTtlMs?: number;

  /** Parallel consumers used by the one-time claim race. Defaults to 16. */
  concurrency?: number;
}

export interface McpUsageFlowStoreConformanceCaseResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface McpUsageFlowStoreConformanceReport {
  passed: boolean;
  cases: McpUsageFlowStoreConformanceCaseResult[];
}

export class McpUsageFlowStoreConformanceError extends Error {
  constructor(public readonly report: McpUsageFlowStoreConformanceReport) {
    const failed = report.cases.filter(result => !result.passed);
    super(
      `McpUsageFlowStore conformance failed: ${failed
        .map(result => `${result.name}: ${result.error ?? 'unknown failure'}`)
        .join('; ')}`,
    );
    this.name = 'McpUsageFlowStoreConformanceError';
  }
}

/**
 * Verify the portable compare-and-consume contract required by
 * protectMultiRoundTool().
 *
 * Passing proves behavioral one-time claim semantics, including the requirement
 * that `consume()` reject expiry before returning a record using the store's own
 * authoritative time domain. Callers treat a returned record as expiry-valid and
 * do not re-check it against an unrelated host clock. Production-safe flow stores
 * must additionally document durability/HA and prove that a lost consume ACK does
 * not trigger caller-side blind retry/re-entry.
 */
export async function runMcpUsageFlowStoreConformance(
  harness: McpUsageFlowStoreConformanceHarness,
): Promise<McpUsageFlowStoreConformanceReport> {
  const flowTtlMs = harness.flowTtlMs ?? 40;
  const concurrency = harness.concurrency ?? 16;
  assertPositiveInteger(flowTtlMs, 'flowTtlMs');
  assertPositiveInteger(concurrency, 'concurrency');

  const cases: McpUsageFlowStoreConformanceCaseResult[] = [];

  await runCase(harness, cases, 'one-time-consume', async store => {
    const record = flowRecord('flow-contract-one-time-0001', 5_000);
    await store.suspend(record);
    const first = await store.consume(record.flowId, record.binding);
    assert(first !== undefined, 'first matching consume must return the flow');
    assertRecordMatches(first, record);
    const replay = await store.consume(record.flowId, record.binding);
    assert(replay === undefined, 'matching flow must be consumed at most once');
  });

  await runCase(harness, cases, 'binding-mismatch-preserves-legitimate-flow', async store => {
    const record = flowRecord('flow-contract-binding-0001', 5_000);
    await store.suspend(record);

    const mismatches: McpUsageFlowBinding[] = [
      { ...record.binding, principalId: 'other-principal' },
      { ...record.binding, tenantId: 'other-tenant' },
      { ...record.binding, tool: 'other-tool' },
      { ...record.binding, argsHash: 'b'.repeat(64) },
    ];
    for (const mismatch of mismatches) {
      const result = await store.consume(record.flowId, mismatch);
      assert(result === undefined, 'binding mismatch must not return trusted flow state');
    }

    const legitimate = await store.consume(record.flowId, record.binding);
    assert(legitimate !== undefined, 'binding mismatch must not consume legitimate flow state');
    assertRecordMatches(legitimate, record);
  });

  await runCase(harness, cases, 'concurrent-one-time-consume', async store => {
    const record = flowRecord('flow-contract-concurrent-0001', 5_000);
    await store.suspend(record);
    const results = await Promise.all(
      Array.from({ length: concurrency }, () => store.consume(record.flowId, record.binding)),
    );
    const winners = results.filter((result): result is McpUsageFlowRecord => result !== undefined);
    assert(winners.length === 1, `expected exactly one consume winner, got ${winners.length}`);
    assertRecordMatches(winners[0]!, record);
  });

  await runCase(harness, cases, 'duplicate-suspend-fails', async store => {
    const record = flowRecord('flow-contract-duplicate-0001', 5_000);
    await store.suspend(record);
    await assertRejects(() => Promise.resolve(store.suspend(record)), 'duplicate flow ID must fail');
    const legitimate = await store.consume(record.flowId, record.binding);
    assert(legitimate !== undefined, 'duplicate suspend failure must preserve original flow');
  });

  await runCase(harness, cases, 'expired-flow-cannot-resume', async store => {
    const record = flowRecord('flow-contract-expiry-0001', flowTtlMs);
    await store.suspend(record);
    await harness.waitForFlowExpiry(flowTtlMs, 'expired-flow-cannot-resume');
    const expired = await store.consume(record.flowId, record.binding);
    assert(expired === undefined, 'expired flow must not resume');
  });

  return { passed: cases.every(result => result.passed), cases };
}

export async function assertMcpUsageFlowStoreConformance(
  harness: McpUsageFlowStoreConformanceHarness,
): Promise<McpUsageFlowStoreConformanceReport> {
  const report = await runMcpUsageFlowStoreConformance(harness);
  if (!report.passed) throw new McpUsageFlowStoreConformanceError(report);
  return report;
}

async function runCase(
  harness: McpUsageFlowStoreConformanceHarness,
  results: McpUsageFlowStoreConformanceCaseResult[],
  name: string,
  body: (store: McpUsageFlowStore) => Promise<void>,
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

function flowRecord(flowId: string, ttlMs: number): McpUsageFlowRecord {
  const now = Date.now();
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > Number.MAX_SAFE_INTEGER - now) {
    throw new RangeError('flow-store conformance ttlMs exceeds safe timestamp range');
  }
  const expiresAt = now + ttlMs;
  return {
    flowId,
    binding: {
      principalId: 'principal-1',
      tenantId: 'tenant-1',
      tool: 'contract-tool',
      argsHash: 'a'.repeat(64),
    },
    lease: {
      reservation: {
        id: 'contract-reservation',
        operationId: 'contract-operation',
        principalId: 'principal-1',
        tenantId: 'tenant-1',
        tool: 'contract-tool',
        budgetKeys: ['contract:budget'],
        reservedUnits: 1,
        expiresAt,
      },
      ttlMs,
      unresolvedGrowth: {
        incrementId: 'contract-growth-increment',
        additionalUnits: 2,
        budgets: [{ key: 'contract:budget', limit: 10 }],
      },
    },
    round: 1,
    expiresAt,
  };
}

function assertRecordMatches(actual: McpUsageFlowRecord, expected: McpUsageFlowRecord): void {
  assert(actual.flowId === expected.flowId, 'flowId changed across storage');
  assert(actual.round === expected.round, 'round changed across storage');
  assert(actual.expiresAt === expected.expiresAt, 'expiresAt changed across storage');
  assert(actual.binding.principalId === expected.binding.principalId, 'principal binding changed');
  assert(actual.binding.tenantId === expected.binding.tenantId, 'tenant binding changed');
  assert(actual.binding.tool === expected.binding.tool, 'tool binding changed');
  assert(actual.binding.argsHash === expected.binding.argsHash, 'args binding changed');
  assert(
    actual.lease.reservation.id === expected.lease.reservation.id,
    'reservation identity changed across storage',
  );
  assert(
    JSON.stringify(actual.lease.unresolvedGrowth) === JSON.stringify(expected.lease.unresolvedGrowth),
    'unresolved growth changed across storage',
  );
  if (expected.lease.unresolvedGrowth !== undefined) {
    assert(
      actual.lease.unresolvedGrowth !== expected.lease.unresolvedGrowth,
      'unresolved growth must be detached from caller state',
    );
    assert(
      actual.lease.unresolvedGrowth?.budgets !== expected.lease.unresolvedGrowth.budgets,
      'unresolved growth budgets must be detached from caller state',
    );
  }
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
