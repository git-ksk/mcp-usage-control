import assert from 'node:assert/strict';
import { MemoryUsageStore, UsageControl } from '../../packages/core/dist/index.js';

const month = '2026-08';
const planLimits = { free: 50, plus: 500 };
const toolCosts = { search: 1, report: 10 };

const control = new UsageControl(new MemoryUsageStore(), {
  quote(request) {
    const plan = request.principal.plan ?? 'free';
    const limit = planLimits[plan];
    const units = toolCosts[request.tool];
    if (limit === undefined || units === undefined) return { decision: 'deny', reason: 'unsupported' };
    return {
      decision: 'allow',
      units,
      budget: { key: `month:${request.principal.id}:${month}`, limit },
    };
  },
});

function request(operationId, tool, principalId = 'free-user', plan = 'free') {
  return { operationId, principal: { id: principalId, plan }, tool, args: {} };
}

// Spend 40 of the Free plan's 50 monthly credits, leaving exactly 10.
for (let i = 0; i < 4; i += 1) {
  const admission = await control.reserve(request(`warmup-${i}`, 'report'));
  assert.equal(admission.allowed, true);
  await admission.lease.markLiable();
  await admission.lease.settle(10, 'success');
}

// Two 10-credit reports race for the final 10 credits. Exactly one may start.
const concurrent = await Promise.all([
  control.reserve(request('report-a', 'report')),
  control.reserve(request('report-b', 'report')),
]);
const allowed = concurrent.filter(result => result.allowed);
const denied = concurrent.filter(result => !result.allowed);
assert.equal(allowed.length, 1, 'exactly one concurrent report must be admitted');
assert.equal(denied.length, 1, 'exactly one concurrent report must be denied');
assert.equal(denied[0].reason, 'quota_exceeded');
await allowed[0].lease.markLiable();
await allowed[0].lease.settle(10, 'success');

// A duplicate logical operation is rejected instead of creating a second reservation.
const admittedOperationId = allowed[0] === concurrent[0] ? 'report-a' : 'report-b';
const duplicate = await control.reserve(request(admittedOperationId, 'report'));
assert.equal(duplicate.allowed, false, 'duplicate logical operation must not reserve again');
assert.equal(duplicate.reason, 'duplicate_operation');

console.log('PASS: Free plan stopped concurrent overspend at 50/50 credits.');
console.log('PASS: duplicate logical operation was rejected instead of charging another 10 credits.');
console.log('The same policy can quote Plus users at 500 credits/month.');
