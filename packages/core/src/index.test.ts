import { describe, expect, it } from 'vitest';
import { MemoryUsageStore, UsageControl, type UsagePolicy } from './index.js';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: 1,
      budget: { key: `monthly:${request.principal.id}`, limit: 1 },
    };
  },
};

function request(operationId: string) {
  return {
    operationId,
    principal: { id: 'user-1', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

describe('UsageControl', () => {
  it('prevents parallel oversubscription', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const results = await Promise.all([
      control.reserve(request('op-a')),
      control.reserve(request('op-b')),
    ]);

    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed && result.reason === 'quota_exceeded')).toHaveLength(1);
  });

  it('releases unused reserved units on settlement', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const first = await control.reserve(request('op-a'));
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    await first.lease.settle(0, 'pre_execution_failure');
    const second = await control.reserve(request('op-b'));
    expect(second.allowed).toBe(true);
  });

  it('blocks duplicate operation IDs', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const first = await control.reserve(request('same-op'));
    expect(first.allowed).toBe(true);

    const duplicate = await control.reserve(request('same-op'));
    expect(duplicate).toEqual({ allowed: false, reason: 'duplicate_operation' });
  });

  it('makes identical settlement idempotent', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');

    const first = await admission.lease.settle(1, 'success');
    const second = await admission.lease.settle(1, 'success');
    expect(second).toEqual(first);
  });
});
