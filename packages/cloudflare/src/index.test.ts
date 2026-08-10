import { describe, expect, it } from 'vitest';
import type { UsageEvent } from 'mcp-usage-control';
import {
  CloudflareUsageStore,
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
  type CloudflareStoreEnvelope,
  type CloudflareUsageDurableObjectStub,
} from './index.js';

const request = {
  operationId: 'operation-secret-123',
  principal: { id: 'user-secret-42', tenantId: 'tenant-secret-7', plan: 'plus' },
  tool: 'secret-tool-name',
  args: { token: 'super-secret-token', query: 'private-query' },
};

function acceptedEnvelope(): CloudflareStoreEnvelope<{
  accepted: true;
  expiresAt: number;
  remainingByBudget: readonly { id: string; remaining: number }[];
}> {
  return {
    ok: true,
    result: { accepted: true, expiresAt: Date.now() + 1_000, remainingByBudget: [] },
    recovery: {
      aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
    },
  };
}

describe('CloudflareUsageStore transport boundary', () => {
  it('hashes request identity and budget keys before calling Durable Objects', async () => {
    let captured: unknown;
    const stub: CloudflareUsageDurableObjectStub = {
      async reserve(command) {
        captured = command;
        return {
          ok: true,
          result: {
            accepted: true,
            expiresAt: Date.now() + 1_000,
            remainingByBudget: command.budgets.map(budget => ({ id: budget.id, remaining: 9 })),
          },
          recovery: {
            aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
          },
        };
      },
      async markLiable(command) {
        return {
          ok: true,
          result: { expiresAt: Date.now() + 1_000 },
          recovery: { aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 } },
        };
      },
      async renew(command) {
        return {
          ok: true,
          result: { expiresAt: Date.now() + command.ttlMs },
          recovery: { aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 } },
        };
      },
      async settle(command) {
        captured = command;
        return {
          ok: true,
          result: { reservedUnits: 1, actualUnits: command.actualUnits, releasedUnits: 0, replayed: false },
          recovery: { aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 } },
        };
      },
    };
    const store = new CloudflareUsageStore({ getByName: () => stub });

    const reserved = await store.reserve({
      request,
      units: 1,
      budgets: [{ key: 'budget:user-secret-42:daily', limit: 10 }],
      ttlMs: 1_000,
    });
    expect(reserved.accepted).toBe(true);
    const encodedReserve = JSON.stringify(captured);
    for (const secret of [
      'operation-secret-123',
      'user-secret-42',
      'tenant-secret-7',
      'secret-tool-name',
      'super-secret-token',
      'private-query',
      'budget:user-secret-42:daily',
    ]) {
      expect(encodedReserve).not.toContain(secret);
    }

    if (!reserved.accepted) throw new Error('expected accepted reservation');
    await store.settle({
      reservationId: reserved.reservation.id,
      actualUnits: 1,
      outcome: 'sensitive-outcome-text',
    });
    expect(JSON.stringify(captured)).not.toContain('sensitive-outcome-text');
  });

  it('swallows recovery observer failures without changing enforcement results', async () => {
    const stub: CloudflareUsageDurableObjectStub = {
      async reserve(command) {
        return {
          ok: true,
          result: {
            accepted: true,
            expiresAt: Date.now() + 1_000,
            remainingByBudget: command.budgets.map(budget => ({ id: budget.id, remaining: 9 })),
          },
          recovery: {
            aggregate: { pendingCount: 1, pendingUnits: 1, liableCount: 1, liableUnits: 2 },
          },
        };
      },
      async markLiable() {
        throw new Error('unused');
      },
      async renew() {
        throw new Error('unused');
      },
      async settle() {
        throw new Error('unused');
      },
    };
    const store = new CloudflareUsageStore(
      { getByName: () => stub },
      {
        observer: {
          onEvent() {
            throw new Error('telemetry unavailable');
          },
        },
      },
    );

    await expect(
      store.reserve({ request, units: 1, budgets: [{ key: 'budget-a', limit: 10 }], ttlMs: 1_000 }),
    ).resolves.toMatchObject({ accepted: true });
  });
});

describe('RemoteCloudflareUsageStore endpoint validation', () => {
  it('requires HTTPS except for explicit local HTTP test endpoints', () => {
    expect(() => new RemoteCloudflareUsageStore({ endpoint: 'ftp://localhost/v1/usage-store' })).toThrow(/HTTPS/);
    expect(() => new RemoteCloudflareUsageStore({ endpoint: 'http://usage.example.test/v1/usage-store' })).toThrow(/HTTPS/);
    expect(() => new RemoteCloudflareUsageStore({ endpoint: 'https://user:pass@usage.example.test/v1/usage-store' })).toThrow(/credentials/);
    expect(() => new RemoteCloudflareUsageStore({ endpoint: 'http://127.0.0.1:8799/v1/usage-store' })).not.toThrow();
  });
});

describe('RemoteCloudflareUsageStore', () => {
  it('sends only hashed accounting identifiers over HTTP', async () => {
    let body = '';
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      headers: { authorization: 'Bearer test-secret' },
      fetch: async (_input, init) => {
        body = String(init?.body ?? '');
        const parsed = JSON.parse(body) as { input: { budgets: { id: string }[] } };
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              accepted: true,
              expiresAt: Date.now() + 1_000,
              remainingByBudget: parsed.input.budgets.map(budget => ({ id: budget.id, remaining: 9 })),
            },
            recovery: {
              aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await store.reserve({
      request,
      units: 1,
      budgets: [{ key: 'budget:user-secret-42:daily', limit: 10 }],
      ttlMs: 1_000,
    });

    for (const secret of [
      'operation-secret-123',
      'user-secret-42',
      'tenant-secret-7',
      'secret-tool-name',
      'super-secret-token',
      'private-query',
      'budget:user-secret-42:daily',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('does not blindly retry an ambiguous network failure', async () => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        calls += 1;
        throw new Error('ack lost after remote commit');
      },
    });

    await expect(
      store.reserve({ request, units: 1, budgets: [{ key: 'budget-a', limit: 10 }], ttlMs: 1_000 }),
    ).rejects.toBeInstanceOf(CloudflareUsageTransportError);
    expect(calls).toBe(1);
  });

  it('emits bounded Cloudflare recovery events', async () => {
    const events: UsageEvent[] = [];
    const hash = 'a'.repeat(64);
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      observer: { onEvent(event) { events.push(event); } },
      fetch: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { expiresAt: Date.now() + 1_000 },
            recovery: {
              direct: { reservationId: `cf1.${hash}`, state: 'liable', reservedUnits: 2 },
              aggregate: { pendingCount: 3, pendingUnits: 3, liableCount: 0, liableUnits: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await store.markLiable({ reservationId: `cf1.${hash}` });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'reservation.recovered',
        store: 'cloudflare',
        recovery: 'liable_retained',
        reservationId: `cf1.${hash}`,
        reservedUnits: 2,
        count: 1,
      }),
      expect.objectContaining({
        type: 'reservation.recovered',
        store: 'cloudflare',
        recovery: 'pending_released',
        reservedUnits: 3,
        count: 3,
      }),
    ]);
  });
});
