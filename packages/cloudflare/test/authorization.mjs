import assert from 'node:assert/strict';

const origin = new URL(
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store',
).origin;
const reservationId = `cf1.${'a'.repeat(64)}`;
const budgetId = 'b'.repeat(64);

const cases = [
  [
    '/test/auth-truthy-usage',
    {
      version: 1,
      method: 'reserve',
      input: {
        reservationId,
        units: 1,
        budgets: [{ id: budgetId, limit: 1 }],
        ttlMs: 1_000,
        initialGrowthCursor: 'cursor-1',
      },
    },
  ],
  [
    '/test/auth-truthy-reconciliation',
    { version: 1, method: 'lookup', input: { reservationId } },
  ],
  [
    '/test/auth-truthy-maintenance',
    {
      version: 1,
      method: 'prune_budgets',
      input: { candidateBudgetIds: [budgetId], protectedBudgetIds: [] },
    },
  ],
];

for (const [pathname, body] of cases) {
  const response = await fetch(new URL(pathname, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 401, `${pathname} must reject truthy non-boolean authorization`);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
}

console.log('Cloudflare literal-true authorization integration: PASS');
