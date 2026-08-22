import { describe, expect, it } from 'vitest';
import {
  createCloudflareUsageStoreGateway,
  type CloudflareGatewayAuthorize,
} from './index.js';
import { createCloudflareBudgetMaintenanceGateway } from './maintenance.js';
import { createReconciliableCloudflareUsageStoreGateway } from './reconciliation.js';

const reservationId = `cf1.${'a'.repeat(64)}`;
const budgetId = 'b'.repeat(64);
const usageBody = {
  version: 1,
  method: 'reserve',
  input: {
    reservationId,
    units: 1,
    budgets: [{ id: budgetId, limit: 1 }],
    ttlMs: 1_000,
    initialGrowthCursor: 'cursor-1',
  },
};
const lookupBody = { version: 1, method: 'lookup', input: { reservationId } };
const maintenanceBody = {
  version: 1,
  method: 'prune_budgets',
  input: { candidateBudgetIds: [budgetId], protectedBudgetIds: [] },
};

const malformedResults: Array<[string, unknown]> = [
  ['string false', 'false'],
  ['string true', 'true'],
  ['number one', 1],
  ['object', {}],
  ['array', []],
  ['null', null],
  ['undefined', undefined],
];

function request(path: string, body: unknown): Request {
  return new Request(`https://usage.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function unsafeAuthorize(value: unknown): CloudflareGatewayAuthorize {
  return (() => value) as unknown as CloudflareGatewayAuthorize;
}

function usageGateway(authorize: CloudflareGatewayAuthorize, calls: { count: number }) {
  return createCloudflareUsageStoreGateway({
    authorize,
    namespace: {
      getByName: () =>
        ({
          async reserve() {
            calls.count += 1;
            return {
              ok: true,
              result: {
                accepted: true,
                expiresAt: Date.now() + 1_000,
                remainingByBudget: [{ id: budgetId, remaining: 0 }],
              },
              recovery: {
                aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
              },
            };
          },
        }) as never,
    },
  });
}

function reconciliationGateway(authorize: CloudflareGatewayAuthorize, calls: { count: number }) {
  return createReconciliableCloudflareUsageStoreGateway({
    authorize,
    namespace: {
      getByName: () =>
        ({
          async lookup() {
            calls.count += 1;
            return { status: 'absent' };
          },
        }) as never,
    },
  });
}

function maintenanceGateway(authorize: CloudflareGatewayAuthorize, calls: { count: number }) {
  return createCloudflareBudgetMaintenanceGateway({
    authorizeMaintenance: authorize,
    namespace: {
      getByName: () =>
        ({
          async pruneBudgets() {
            calls.count += 1;
            return {
              prunedIds: [budgetId],
              blockedProtectedIds: [],
              blockedActiveIds: [],
              missingIds: [],
            };
          },
        }) as never,
    },
  });
}

describe('Cloudflare gateway authorization runtime boundary', () => {
  it.each(malformedResults)('usage gateway rejects truthy/malformed runtime result: %s', async (_name, value) => {
    const calls = { count: 0 };
    const response = await usageGateway(unsafeAuthorize(value), calls)(request('/v1/usage-store', usageBody));
    expect(response.status).toBe(401);
    expect(calls.count).toBe(0);
  });

  it.each(malformedResults)('reconciliation gateway rejects truthy/malformed runtime result: %s', async (_name, value) => {
    const calls = { count: 0 };
    const response = await reconciliationGateway(unsafeAuthorize(value), calls)(request('/v1/usage-store', lookupBody));
    expect(response.status).toBe(401);
    expect(calls.count).toBe(0);
  });

  it.each(malformedResults)('maintenance gateway rejects truthy/malformed runtime result: %s', async (_name, value) => {
    const calls = { count: 0 };
    const response = await maintenanceGateway(unsafeAuthorize(value), calls)(request('/v1/usage-store-maintenance', maintenanceBody));
    expect(response.status).toBe(401);
    expect(calls.count).toBe(0);
  });

  it('literal true is the only result that reaches all three Durable Object methods', async () => {
    const usageCalls = { count: 0 };
    const lookupCalls = { count: 0 };
    const maintenanceCalls = { count: 0 };

    expect((await usageGateway(() => true, usageCalls)(request('/v1/usage-store', usageBody))).status).toBe(200);
    expect((await reconciliationGateway(() => true, lookupCalls)(request('/v1/usage-store', lookupBody))).status).toBe(200);
    expect((await maintenanceGateway(() => true, maintenanceCalls)(request('/v1/usage-store-maintenance', maintenanceBody))).status).toBe(200);
    expect([usageCalls.count, lookupCalls.count, maintenanceCalls.count]).toEqual([1, 1, 1]);
  });

  it('thrown and rejected authorizers remain fail-closed without reaching Durable Objects', async () => {
    const thrown = (() => {
      throw new Error('auth-secret');
    }) as CloudflareGatewayAuthorize;
    const rejected = (() => Promise.reject(new Error('auth-secret'))) as CloudflareGatewayAuthorize;

    for (const authorize of [thrown, rejected]) {
      const usageCalls = { count: 0 };
      const lookupCalls = { count: 0 };
      const maintenanceCalls = { count: 0 };
      expect((await usageGateway(authorize, usageCalls)(request('/v1/usage-store', usageBody))).status).toBe(401);
      expect((await reconciliationGateway(authorize, lookupCalls)(request('/v1/usage-store', lookupBody))).status).toBe(401);
      expect((await maintenanceGateway(authorize, maintenanceCalls)(request('/v1/usage-store-maintenance', maintenanceBody))).status).toBe(401);
      expect([usageCalls.count, lookupCalls.count, maintenanceCalls.count]).toEqual([0, 0, 0]);
    }
  });
});
