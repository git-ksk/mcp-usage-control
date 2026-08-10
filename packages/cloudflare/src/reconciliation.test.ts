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

  it('fails closed on Cloudflare gateway unavailability', async () => {
    await expect(
      reconcileRemoteCloudflareReserve(
        {
          endpoint: 'https://usage.example.test/v1/usage-store',
          fetch: async () =>
            new Response(JSON.stringify({ error: 'store_unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
        },
        { request, units: 1, budgets },
      ),
    ).rejects.toMatchObject({ code: 'remote' });
  });
});
