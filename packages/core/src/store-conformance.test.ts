import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryUsageStore } from './index.js';
import {
  assertUsageStoreConformance,
  runProgressiveUsageStoreConformance,
  runVectorUsageStoreConformance,
  runUsageStoreConformance,
} from './store-conformance.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageStore conformance kit', () => {
  it('accepts the MemoryUsageStore reference implementation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

    const report = await assertUsageStoreConformance({
      createStore() {
        return new MemoryUsageStore();
      },
      async waitForLeaseExpiry(ttlMs) {
        await vi.advanceTimersByTimeAsync(ttlMs + 1);
      },
    });

    expect(report.passed).toBe(true);
    expect(report.cases.every(result => result.passed)).toBe(true);
  });

  it('accepts the MemoryUsageStore progressive growth contract', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));

    const report = await runProgressiveUsageStoreConformance({
      createStore() {
        return new MemoryUsageStore();
      },
      async waitForLeaseExpiry(ttlMs) {
        await vi.advanceTimersByTimeAsync(ttlMs + 1);
      },
    });

    expect(report.passed).toBe(true);
    expect(report.cases.every(result => result.passed)).toBe(true);
  });

  it('accepts the MemoryUsageStore atomic vector contract', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));

    const report = await runVectorUsageStoreConformance({
      createStore() {
        return new MemoryUsageStore();
      },
      async waitForLeaseExpiry(ttlMs) {
        await vi.advanceTimersByTimeAsync(ttlMs + 1);
      },
    });

    expect(report.passed).toBe(true);
    expect(report.cases.every(result => result.passed)).toBe(true);
  });

  it('reports a store that violates the atomic admission contract', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

    class BrokenStore extends MemoryUsageStore {
      override async reserve(input: Parameters<MemoryUsageStore['reserve']>[0]) {
        if (input.request.operationId === 'must-not-partially-reserve') {
          await super.reserve({
            ...input,
            request: { ...input.request, operationId: 'broken-partial-write' },
            budgets: [input.budgets[0]!],
          });
        }
        return super.reserve(input);
      }
    }

    const report = await runUsageStoreConformance({
      createStore() {
        return new BrokenStore();
      },
      async waitForLeaseExpiry(ttlMs) {
        await vi.advanceTimersByTimeAsync(ttlMs + 1);
      },
    });

    expect(report.passed).toBe(false);
    expect(report.cases).toContainEqual(
      expect.objectContaining({ name: 'atomic-multi-budget-denial', passed: false }),
    );
  });
});
