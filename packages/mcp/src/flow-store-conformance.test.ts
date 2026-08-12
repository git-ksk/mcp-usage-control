import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryMcpUsageFlowStore } from './index.js';
import { assertMcpUsageFlowStoreConformance } from './flow-store-conformance.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('McpUsageFlowStore conformance kit', () => {
  it('accepts the process-local reference flow store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));

    const report = await assertMcpUsageFlowStoreConformance({
      createStore() {
        return new MemoryMcpUsageFlowStore();
      },
      async waitForFlowExpiry(ttlMs) {
        await vi.advanceTimersByTimeAsync(ttlMs + 1);
      },
    });

    expect(report.passed).toBe(true);
    expect(report.cases.every(result => result.passed)).toBe(true);
  });
});
