import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from './index.js';
import { createExactRetryingRemoteCloudflareUsageStore } from './exact-retry.js';

const reservationId = `cf1.${'a'.repeat(64)}`;
const request = {
  operationId: 'exact-retry-operation',
  principal: { id: 'user-a', tenantId: 'tenant-a', plan: 'free' },
  tool: 'read-tool',
  args: {},
};

const fastBackoff = { initialBackoffMs: 1, maxBackoffMs: 1 } as const;

const recovery = {
  aggregate: { pendingCount: 0, pendingUnits: 0, liableCount: 0, liableUnits: 0 },
};

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result, recovery }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createExactRetryingRemoteCloudflareUsageStore', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never retries initial reserve ambiguity', async () => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        calls += 1;
        throw new Error('lost reserve acknowledgement');
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

    await expect(
      retrying.reserve({
        request,
        units: 1,
        budgets: [{ key: 'budget-a', limit: 10 }],
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(calls).toBe(1);
  });

  it.each([
    {
      name: 'markLiable',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.markLiable({ reservationId }),
      success: { expiresAt: 5_000 },
    },
    {
      name: 'renew',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.renew({ reservationId, ttlMs: 1_000 }),
      success: { expiresAt: 6_000 },
    },
    {
      name: 'settle',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.settle({ reservationId, actualUnits: 1, outcome: 'success' }),
      success: { reservedUnits: 2, actualUnits: 1, releasedUnits: 1, replayed: true },
    },
  ])('replays the exact same $name request once after a lost acknowledgement', async ({ invoke, success }) => {
    const bodies: string[] = [];
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async (_input, init) => {
        calls += 1;
        bodies.push(String(init?.body ?? ''));
        if (calls === 1) throw new Error('ack lost after remote commit');
        return jsonResponse(success);
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

    await expect(invoke(retrying)).resolves.toBeDefined();
    expect(calls).toBe(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('replays once after an actual client timeout for an eligible method', async () => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      timeoutMs: 20,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Promise<Response>(() => {});
        return jsonResponse({ expiresAt: 5_000 });
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

    await expect(retrying.markLiable({ reservationId })).resolves.toMatchObject({ reservationId });
    expect(calls).toBe(2);
  });

  it.each([408, 429, 500, 502, 503, 520, 599])(
    'retries bounded transient HTTP status %i for eligible exact replay',
    async status => {
      let calls = 0;
      const store = new RemoteCloudflareUsageStore({
        endpoint: 'https://usage.example.test/v1/usage-store',
        fetch: async () => {
          calls += 1;
          if (calls === 1) return new Response('', { status });
          return jsonResponse({ expiresAt: 5_000 });
        },
      });
      const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

      await expect(retrying.markLiable({ reservationId })).resolves.toMatchObject({ reservationId });
      expect(calls).toBe(2);
    },
  );

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
    ['client error', 400],
    ['conflict transport status', 409],
  ])('does not retry %s transport failures', async (_name, status) => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        calls += 1;
        return new Response('', { status });
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

    await expect(retrying.markLiable({ reservationId })).rejects.toBeInstanceOf(
      CloudflareUsageTransportError,
    );
    expect(calls).toBe(1);
  });

  it('surfaces a conflicting settlement replay instead of converting it to success', async () => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ack lost after remote commit');
        return new Response(
          JSON.stringify({ ok: false, error: 'settlement_conflict', recovery }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

    await expect(
      retrying.settle({ reservationId, actualUnits: 1, outcome: 'success' }),
    ).rejects.toThrow(/already settled/i);
    expect(calls).toBe(2);
  });

  it('uses bounded exponential equal-jitter backoff between retryable attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const callTimes: number[] = [];
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        callTimes.push(Date.now());
        throw new Error('still ambiguous');
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, {
      maxAttempts: 4,
      initialBackoffMs: 100,
      maxBackoffMs: 250,
    });

    const result = expect(retrying.markLiable({ reservationId })).rejects.toMatchObject({ code: 'network' });
    await vi.runAllTimersAsync();
    await result;

    // Equal jitter with Math.random() = 0 uses the lower half-bound:
    // 50ms, 100ms, then the 250ms cap contributes 125ms.
    expect(callTimes).toEqual([0, 50, 150, 275]);
  });

  it('keeps equal-jitter delay at or below each exponential cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);

    const callTimes: number[] = [];
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        callTimes.push(Date.now());
        throw new Error('still ambiguous');
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, {
      maxAttempts: 4,
      initialBackoffMs: 100,
      maxBackoffMs: 250,
    });

    const result = expect(retrying.markLiable({ reservationId })).rejects.toMatchObject({ code: 'network' });
    await vi.runAllTimersAsync();
    await result;
    expect(callTimes).toEqual([0, 100, 300, 550]);
  });

  it('does not add retry backoff to non-retryable or single-attempt calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const nonRetryable = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => new Response('', { status: 400 }),
    });
    const retryingNonRetryable = createExactRetryingRemoteCloudflareUsageStore(nonRetryable, {
      initialBackoffMs: 500,
      maxBackoffMs: 1_000,
    });
    await expect(retryingNonRetryable.markLiable({ reservationId })).rejects.toBeInstanceOf(
      CloudflareUsageTransportError,
    );
    expect(Date.now()).toBe(0);

    const reserveStore = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        throw new Error('ambiguous reserve');
      },
    });
    const retryingReserve = createExactRetryingRemoteCloudflareUsageStore(reserveStore, {
      initialBackoffMs: 500,
      maxBackoffMs: 1_000,
    });
    await expect(
      retryingReserve.reserve({
        request,
        units: 1,
        budgets: [{ key: 'budget-a', limit: 10 }],
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(Date.now()).toBe(0);
  });

  it('honors explicit maxAttempts bounds', async () => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        calls += 1;
        throw new Error('still ambiguous');
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, { maxAttempts: 3, ...fastBackoff });

    await expect(retrying.markLiable({ reservationId })).rejects.toMatchObject({ code: 'network' });
    expect(calls).toBe(3);

    expect(() => createExactRetryingRemoteCloudflareUsageStore(store, { maxAttempts: 0 })).toThrow(
      /maxAttempts/,
    );
    expect(() => createExactRetryingRemoteCloudflareUsageStore(store, { maxAttempts: 5 })).toThrow(
      /maxAttempts/,
    );
    expect(() =>
      createExactRetryingRemoteCloudflareUsageStore(store, { initialBackoffMs: 0 }),
    ).toThrow(/initialBackoffMs/);
    expect(() =>
      createExactRetryingRemoteCloudflareUsageStore(store, { maxBackoffMs: 60_001 }),
    ).toThrow(/maxBackoffMs/);
    expect(() =>
      createExactRetryingRemoteCloudflareUsageStore(store, {
        initialBackoffMs: 1_000,
        maxBackoffMs: 500,
      }),
    ).toThrow(/maxBackoffMs/);
  });

  it.each([
    {
      name: 'reserveVector',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.reserveVector({
          request: { ...request, operationId: 'vector-reserve-no-retry' },
          dimensions: [{ key: 'requests', units: 1, budgets: [{ key: 'budget-a', limit: 10 }] }],
          ttlMs: 1_000,
        }),
    },
    {
      name: 'growReservation',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.growReservation({
          reservationId,
          incrementId: 'growth-1',
          expectedGrowthCursor: 'g1.expected',
          additionalUnits: 1,
          budgets: [{ key: 'budget-a', limit: 10 }],
        }),
    },
    {
      name: 'growVectorReservation',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.growVectorReservation({
          reservationId,
          incrementId: 'vector-growth-1',
          expectedGrowthCursor: 'g1.expected',
          dimensions: [
            {
              key: 'requests',
              additionalUnits: 1,
              budgets: [{ key: 'budget-a', limit: 10 }],
            },
          ],
        }),
    },
    {
      name: 'settleVector',
      invoke: (store: ReturnType<typeof createExactRetryingRemoteCloudflareUsageStore>) =>
        store.settleVector({
          reservationId,
          actualByDimension: [{ key: 'requests', actualUnits: 1 }],
          outcome: 'success',
        }),
    },
  ])('keeps $name single-attempt', async ({ invoke }) => {
    let calls = 0;
    const store = new RemoteCloudflareUsageStore({
      endpoint: 'https://usage.example.test/v1/usage-store',
      fetch: async () => {
        calls += 1;
        throw new Error('ambiguous');
      },
    });
    const retrying = createExactRetryingRemoteCloudflareUsageStore(store, fastBackoff);

    await expect(invoke(retrying)).rejects.toMatchObject({ code: 'network' });
    expect(calls).toBe(1);
  });
});
