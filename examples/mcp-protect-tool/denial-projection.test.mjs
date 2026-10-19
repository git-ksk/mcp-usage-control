import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageDeniedError } from 'mcp-usage-control';
import { runQuotaDenialSdkExample } from './denial-example.mjs';
import { safeDenialResult } from './denial-projection.mjs';

const privateKey = 'private:tenant-abc:user-xyz:daily';
const safeArgs = {
  approvedScopes: new Map([[privateKey, 'daily']]),
  approvedNextBoundaryByKey: new Map([[privateKey, Date.parse('2026-10-20T00:00:00Z')]]),
};

test('official MCP SDK projects first limiter with a known calendar boundary, not guaranteed availability', async () => {
  const proof = await runQuotaDenialSdkExample();
  assert.equal(proof.handlerEntries, 1, 'no paid work on a second blocked call');
  assert.equal(proof.second.structuredContent.retrySafeAt, null, 'another budget could still be exhausted');
  assert.equal(proof.second.structuredContent.scope, 'daily');
  assert.ok(proof.second.structuredContent.nextWindowBoundary);
});

test('unknown limiter, simultaneous blockers and unknown reset never invent retry time', () => {
  const err = new UsageDeniedError('quota_exceeded', { limitingBudgetKey: 'private:another-budget', remaining: 0 });
  const result = safeDenialResult(err, safeArgs);
  assert.deepEqual(result.structuredContent, {
    status: 'denied', reason: 'quota_exceeded', scope: 'unknown',
    nextWindowBoundary: null, retrySafeAt: null,
  });
  assert.equal(JSON.stringify(result).includes('another-budget'), false);
});

test('allowlisted daily limiter with shared exhaustion still only exposes an advisory boundary', () => {
  const err = new UsageDeniedError('quota_exceeded', { limitingBudgetKey: privateKey, remaining: 0 });
  const result = safeDenialResult(err, safeArgs);
  assert.equal(result.structuredContent.scope, 'daily');
  assert.equal(result.structuredContent.nextWindowBoundary, '2026-10-20T00:00:00.000Z');
  assert.equal(result.structuredContent.retrySafeAt, null);
  assert.equal(JSON.stringify(result).includes(privateKey), false);
});

test('unknown client-controlled labels are not blindly reflected, malformed boundary never throws', () => {
  for (const scope of ['private-tenant-abc', 'daily\nsecret', null, undefined]) {
    const result = safeDenialResult(new UsageDeniedError('quota_exceeded', { limitingBudgetKey: privateKey }), {
      approvedScopes: new Map([[privateKey, scope]]),
      approvedNextBoundaryByKey: new Map([[privateKey, Number.MAX_SAFE_INTEGER]]),
    });
    assert.equal(result.structuredContent.scope, 'unknown');
    assert.equal(result.structuredContent.nextWindowBoundary, null);
  }
});

test('arbitrary policy reason and backend errors never leak messages or invent retry', () => {
  for (const err of [new UsageDeniedError('private-internal-plan-key', { limitingBudgetKey: privateKey }), new Error('secret registry token')]) {
    const result = safeDenialResult(err, safeArgs);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.retrySafeAt, null);
    assert.equal(result.structuredContent.nextWindowBoundary, null);
    assert.equal(JSON.stringify(result).includes('private-internal-plan-key'), false);
    assert.equal(JSON.stringify(result).includes('secret registry token'), false);
  }
});

test('duplicate logical operation does not become a reset or retry suggestion', () => {
  const result = safeDenialResult(new UsageDeniedError('duplicate_operation', { limitingBudgetKey: privateKey }), safeArgs);
  assert.equal(result.structuredContent.reason, 'duplicate_operation');
  assert.equal(result.structuredContent.nextWindowBoundary, null);
  assert.equal(result.structuredContent.retrySafeAt, null);
});
