import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import {
  assertUsageStoreConformance,
  runOperationReconciliationStoreConformance,
  runProgressiveUsageStoreConformance,
  runVectorUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import { RedisUsageStore } from './index.js';

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const client = createClient({ url: redisUrl ?? 'redis://127.0.0.1:6379' });
const runId = `portable-${Date.now()}`;

integration('RedisUsageStore portable conformance', () => {
  beforeAll(async () => {
    await client.connect();
    await client.flushDb();
  });

  afterAll(async () => {
    await client.flushDb();
    await client.quit();
  });

  it('passes the UsageStore contract including mutable limits', async () => {
    const report = await assertUsageStoreConformance({
      createStore(scenario) {
        return new RedisUsageStore(client, {
          prefix: `${runId}-${scenario}`,
          hashTag: `${runId}-${scenario}`,
        });
      },
      async waitForLeaseExpiry(ttlMs) {
        await new Promise(resolve => setTimeout(resolve, ttlMs + 80));
      },
      leaseTtlMs: 60,
      concurrency: 8,
    });

    expect(report.passed).toBe(true);
    expect(report.cases.every(result => result.passed)).toBe(true);
  });

  it('passes the scalar operation reconciliation contract', async () => {
    const report = await runOperationReconciliationStoreConformance({
      createStore(scenario) {
        return new RedisUsageStore(client, {
          prefix: `${runId}-reconcile-${scenario}`,
          hashTag: `${runId}-reconcile-${scenario}`,
        });
      },
      async waitForLeaseExpiry(ttlMs) {
        await new Promise(resolve => setTimeout(resolve, ttlMs + 80));
      },
      leaseTtlMs: 60,
    });

    expect(report.cases.filter(result => !result.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('passes the progressive reservation growth contract', async () => {
    const report = await runProgressiveUsageStoreConformance({
      createStore(scenario) {
        return new RedisUsageStore(client, {
          prefix: `${runId}-growth-${scenario}`,
          hashTag: `${runId}-growth-${scenario}`,
        });
      },
      async waitForLeaseExpiry(ttlMs) {
        await new Promise(resolve => setTimeout(resolve, ttlMs + 80));
      },
      leaseTtlMs: 60,
    });

    expect(report.cases.filter(result => !result.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });
  it('passes the atomic vector usage contract', async () => {
    const report = await runVectorUsageStoreConformance({
      createStore(scenario) {
        return new RedisUsageStore(client, {
          prefix: `${runId}-vector-${scenario}`,
          hashTag: `${runId}-vector-${scenario}`,
        });
      },
      async waitForLeaseExpiry(ttlMs) {
        await new Promise(resolve => setTimeout(resolve, ttlMs + 80));
      },
      leaseTtlMs: 60,
      concurrency: 8,
    });

    expect(report.cases.filter(result => !result.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

});
