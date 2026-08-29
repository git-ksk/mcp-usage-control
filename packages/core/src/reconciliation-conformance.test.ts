import { describe, expect, it } from 'vitest';
import { MemoryUsageStore } from './index.js';
import {
  runOperationReconciliationStoreConformance,
  runVectorOperationReconciliationStoreConformance,
} from './reconciliation-conformance.js';

describe('operation reconciliation conformance', () => {
  it('passes for MemoryUsageStore', async () => {
    const report = await runOperationReconciliationStoreConformance({
      createStore: () => new MemoryUsageStore(),
      waitForLeaseExpiry: ttlMs => new Promise(resolve => setTimeout(resolve, ttlMs + 5)),
      leaseTtlMs: 10,
    });
    expect(report).toMatchObject({ passed: true });
  });

  it('passes vector reconciliation for MemoryUsageStore', async () => {
    const report = await runVectorOperationReconciliationStoreConformance({
      createStore: () => new MemoryUsageStore(),
      waitForLeaseExpiry: ttlMs => new Promise(resolve => setTimeout(resolve, ttlMs + 5)),
      leaseTtlMs: 10,
    });
    expect(report).toMatchObject({ passed: true });
  });
});
