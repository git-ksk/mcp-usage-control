import { describe, expect, it } from 'vitest';
import { UsageStateError } from 'mcp-usage-control';
import { reconcileRemoteCloudflareReserve } from './reconciliation.js';

const request = {
  operationId: 'operation-secret-123',
  principal: { id: 'user-secret-42', tenantId: 'tenant-secret-7', plan: 'free' },
  tool: 'secret-tool-name',
  args: { token: 'super-secret-token', query: 'private-query' },
};
const budgets = [{ key: 'budget:user-secret-42:daily', limit: 10 }];

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('remote Cloudflare reserve reconciliation', () => {
  it('sends only an opaque reservation ID and reconstructs active pending state locally', async () => {
    let sentBody = '';
    const budgetId = await digest(budgets[0]!.key);

    const result = await reconcileRemoteCloudflareReserve(
      {
        endpoint: 'https://usage.example.test/v1/usage-store',
        headers: { authorization: 'Bearer test-secret' },
        fetch: async (_input, init) => {
          sentBody = String(init?.body ?? '');
          const body = JSON.parse(sentBody) as { input: { reservationId: string } };
          return new Response(
            JSON.stringify({
              version: 1,
              result: {
                status: 'active',
                state: 'pending',
                reservationId: body.input.reservationId,
                reservedUnits: 1,
                expiresAt: 9_999,
                budgetIds: [budgetId],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
      { request, units: 1, budgets },
    );

    expect(result).toEqual({
      status: 'active',
      state: 'pending',
      reservation: {
        id: expect.stringMatching(/^cf1\.[a-f0-9]{64}$/),
        operationId: request.operationId,
        principalId: request.principal.id,
        tenantId: request.principal.tenantId,
        plan: request.principal.plan,
        tool: request.tool,
        budgetKeys: [budgets[0]!.key],
        reservedUnits: 1,
        expiresAt: 9_999,
      },
    });

    const parsed = JSON.parse(sentBody) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      version: 1,
      method: 'lookup',
      input: { reservationId: expect.stringMatching(/^cf1\.[a-f0-9]{64}$/) },
    });
    for (const secret of [
      request.operationId,
      request.principal.id,
      request.principal.tenantId,
      request.tool,
      request.args.token,
      request.args.query,
      budgets[0]!.key,
    ]) {
      expect(sentBody).not.toContain(secret);
    }
  });

  it('returns absent without inventing a reservation', async () => {
    const result = await reconcileRemoteCloudflareReserve(
      {
        endpoint: 'https://usage.example.test/v1/usage-store',
        fetch: async () =>
          new Response(JSON.stringify({ version: 1, result: { status: 'absent' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
      { request, units: 1, budgets },
    );

    expect(result).toMatchObject({
      status: 'absent',
      reservationId: expect.stringMatching(/^cf1\.[a-f0-9]{64}$/),
    });
  });

  it('rejects a reply that does not match the original reserve units', async () => {
    const budgetId = await digest(budgets[0]!.key);

    await expect(
      reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          fetch: async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as {
              input: { reservationId: string };
            };
            return new Response(
              JSON.stringify({
                version: 1,
                result: {
                  status: 'active',
                  state: 'pending',
                  reservationId: body.input.reservationId,
                  reservedUnits: 2,
                  expiresAt: 9_999,
                  budgetIds: [budgetId],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
        { request, units: 1, budgets },
      ),
    ).rejects.toBeInstanceOf(UsageStateError);
  });

  it('rejects a reply whose hashed budgets do not match the original reserve', async () => {
    await expect(
      reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          fetch: async (_input, init) => {
            const body = JSON.parse(String(init?.body ?? '{}')) as {
              input: { reservationId: string };
            };
            return new Response(
              JSON.stringify({
                version: 1,
                result: {
                  status: 'active',
                  state: 'pending',
                  reservationId: body.input.reservationId,
                  reservedUnits: 1,
                  expiresAt: 9_999,
                  budgetIds: ['f'.repeat(64)],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
        { request, units: 1, budgets },
      ),
    ).rejects.toBeInstanceOf(UsageStateError);
  });

  it('rejects timeoutMs above the portable timer ceiling before transport work', async () => {
    let fetchCalled = false;
    await expect(
      reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          timeoutMs: 2_147_483_648,
          fetch: async () => { fetchCalled = true; return new Response('{}'); },
        },
        { request, units: 1, budgets },
      ),
    ).rejects.toThrow(/must not exceed 2147483647ms/);
    expect(fetchCalled).toBe(false);
  });

  it('applies the deadline while resolving rotating headers', async () => {
    await expect(
      reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          headers: () => new Promise<HeadersInit>(() => undefined),
          fetch: async () => {
            throw new Error('fetch must not run');
          },
          timeoutMs: 20,
        },
        { request, units: 1, budgets },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('applies the same deadline while reading a stalled response body', async () => {
    await expect(
      reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // Intentionally never enqueue or close: response.json() remains pending.
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          timeoutMs: 20,
        },
        { request, units: 1, budgets },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it.each([429, 503])('retains bounded HTTP status metadata for remote status %i', async status => {
    const secretBody = 'upstream-secret-must-not-leak';
    let error: unknown;
    try {
      await reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          fetch: async () => new Response(secretBody, { status }),
        },
        { request, units: 1, budgets },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: 'remote',
      status,
      message: 'Cloudflare usage store transport failed',
    });
    expect(String(error)).not.toContain(secretBody);
  });

  it('retains status metadata for unauthorized responses without exposing the body', async () => {
    const secretBody = 'credential-detail-must-not-leak';
    let error: unknown;
    try {
      await reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          fetch: async () => new Response(secretBody, { status: 401 }),
        },
        { request, units: 1, budgets },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: 'unauthorized',
      status: 401,
      message: 'Cloudflare usage store transport failed',
    });
    expect(String(error)).not.toContain(secretBody);
  });
});
