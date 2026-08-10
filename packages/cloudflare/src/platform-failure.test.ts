import { describe, expect, it } from 'vitest';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from './index.js';

const request = {
  operationId: 'platform-separation-operation',
  principal: { id: 'user-1', tenantId: 'tenant-1', plan: 'free' },
  tool: 'tool-a',
  args: {},
};

describe('Cloudflare platform failures vs usage-control quota denial', () => {
  it('returns business quota denial as a normal reserve result', async () => {
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          input: { budgets: Array<{ id: string }> };
        };
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              accepted: false,
              reason: 'quota_exceeded',
              limitingBudgetId: body.input.budgets[0]?.id,
              remaining: 0,
            },
            recovery: {
              aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await expect(
      store.reserve({
        request,
        units: 1,
        budgets: [{ key: 'user:daily', limit: 10 }],
        ttlMs: 1_000,
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: 'user:daily',
      remaining: 0,
    });
  });

  it('fails closed when the remote Cloudflare store is unavailable', async () => {
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () =>
        new Response(JSON.stringify({ error: 'store_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(
      store.reserve({
        request,
        units: 1,
        budgets: [{ key: 'user:daily', limit: 10 }],
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<CloudflareUsageTransportError>>({
      code: 'remote',
    });
  });
});
