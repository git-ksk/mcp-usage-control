import { describe, expect, it } from 'vitest';
import { pruneRemoteCloudflareHistoricalBudgets } from './maintenance.js';

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('remote Cloudflare historical budget maintenance', () => {
  it('sends only hashed budget IDs and maps classifications back to local keys', async () => {
    const historical = 'tenant:user:daily:2026-08-01';
    const current = 'tenant:user:daily:2026-08-11';
    const active = 'tenant:user:job:active';
    const missing = 'tenant:user:old:missing';
    const historicalId = await digest(historical);
    const currentId = await digest(current);
    const activeId = await digest(active);
    const missingId = await digest(missing);
    let sentBody = '';

    const result = await pruneRemoteCloudflareHistoricalBudgets(
      {
        endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
        headers: { authorization: 'Bearer maintenance-secret' },
        fetch: async (_input, init) => {
          sentBody = String(init?.body ?? '');
          return new Response(
            JSON.stringify({
              version: 1,
              result: {
                prunedIds: [historicalId],
                blockedProtectedIds: [currentId],
                blockedActiveIds: [activeId],
                missingIds: [missingId],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
      {
        historicalBudgetKeys: [historical, current, active, missing],
        protectedCurrentBudgetKeys: [current],
      },
    );

    expect(result).toEqual({
      prunedKeys: [historical],
      blockedProtectedKeys: [current],
      blockedActiveKeys: [active],
      missingKeys: [missing],
    });
    const body = JSON.parse(sentBody) as {
      version: number;
      method: string;
      input: { candidateBudgetIds: string[]; protectedBudgetIds: string[] };
    };
    expect(body.version).toBe(1);
    expect(body.method).toBe('prune_budgets');
    expect(body.input.candidateBudgetIds).toEqual([
      historicalId,
      currentId,
      activeId,
      missingId,
    ]);
    expect(body.input.protectedBudgetIds).toEqual([currentId]);
    for (const raw of [historical, current, active, missing]) {
      expect(sentBody).not.toContain(raw);
    }
  });

  it('rejects timeoutMs above the portable timer ceiling before transport work', async () => {
    let fetchCalled = false;
    await expect(
      pruneRemoteCloudflareHistoricalBudgets(
        {
          endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
          timeoutMs: 2_147_483_648,
          fetch: async () => { fetchCalled = true; return new Response('{}'); },
        },
        { historicalBudgetKeys: ['historical-key'], protectedCurrentBudgetKeys: [] },
      ),
    ).rejects.toThrow(/must not exceed 2147483647ms/);
    expect(fetchCalled).toBe(false);
  });

  it('applies timeoutMs while resolving asynchronous maintenance headers', async () => {
    let fetchCalled = false;
    await expect(
      pruneRemoteCloudflareHistoricalBudgets(
        {
          endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
          timeoutMs: 20,
          headers: () => new Promise<HeadersInit>(() => undefined),
          fetch: async () => {
            fetchCalled = true;
            return new Response('{}');
          },
        },
        { historicalBudgetKeys: ['historical-key'], protectedCurrentBudgetKeys: [] },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchCalled).toBe(false);
  });

  it('applies timeoutMs while reading a stalled maintenance response body', async () => {
    await expect(
      pruneRemoteCloudflareHistoricalBudgets(
        {
          endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
          timeoutMs: 20,
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // Intentionally never enqueue or close.
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
        { historicalBudgetKeys: ['historical-key'], protectedCurrentBudgetKeys: [] },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'remote'],
    [503, 'remote'],
  ] as const)('preserves HTTP %i as bounded maintenance error metadata', async (status, code) => {
    const secretBody = 'maintenance-upstream-secret';
    let caught: unknown;
    try {
      await pruneRemoteCloudflareHistoricalBudgets(
        {
          endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
          fetch: async () => new Response(secretBody, { status }),
        },
        { historicalBudgetKeys: ['historical-key'], protectedCurrentBudgetKeys: [] },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code, status });
    expect(String(caught)).not.toContain(secretBody);
  });

  it('fails closed when the maintenance reply omits a candidate', async () => {
    await expect(
      pruneRemoteCloudflareHistoricalBudgets(
        {
          endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
          fetch: async () =>
            new Response(
              JSON.stringify({
                version: 1,
                result: {
                  prunedIds: [],
                  blockedProtectedIds: [],
                  blockedActiveIds: [],
                  missingIds: [],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
        {
          historicalBudgetKeys: ['historical-key'],
          protectedCurrentBudgetKeys: [],
        },
      ),
    ).rejects.toThrow(/omitted/);
  });

  it('fails closed on maintenance endpoint unavailability', async () => {
    await expect(
      pruneRemoteCloudflareHistoricalBudgets(
        {
          endpoint: 'https://usage.example.test/v1/usage-store-maintenance',
          fetch: async () =>
            new Response(JSON.stringify({ error: 'store_unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
        },
        {
          historicalBudgetKeys: ['historical-key'],
          protectedCurrentBudgetKeys: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'remote', status: 503 });
  });
});
