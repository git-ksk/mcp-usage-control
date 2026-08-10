import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  type UsageEvent,
  type UsageObserver,
  type UsagePolicy,
} from './index.js';

const request = {
  operationId: 'op-1',
  principal: { id: 'user-1', tenantId: 'tenant-1', plan: 'free' },
  tool: 'search',
  args: { secret: 'must-not-be-captured', query: 'example' },
};

const policy: UsagePolicy = {
  quote() {
    return {
      decision: 'allow',
      units: 2,
      budgets: [
        { key: 'user:daily', limit: 10 },
        { key: 'tenant:monthly', limit: 100 },
      ],
      reservationTtlMs: 30,
    };
  },
};

function collector(events: UsageEvent[]): UsageObserver {
  return {
    onEvent(event) {
      events.push(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('provider-neutral observability', () => {
  it('emits accepted and settlement events without tool args', async () => {
    const events: UsageEvent[] = [];
    const observer = collector(events);
    const control = new UsageControl(new MemoryUsageStore({ observer }), policy, {
      observer,
      metadata: { environment: 'test' },
    });

    const admission = await control.reserve(request);
    if (!admission.allowed) throw new Error('expected admission');
    await admission.lease.markLiable();
    await admission.lease.settle(1, 'success');

    expect(events.map(event => event.type)).toEqual([
      'reserve.accepted',
      'settlement.completed',
    ]);

    const accepted = events[0];
    expect(accepted).toMatchObject({
      type: 'reserve.accepted',
      principalId: 'user-1',
      tenantId: 'tenant-1',
      plan: 'free',
      tool: 'search',
      operationId: 'op-1',
      reservedUnits: 2,
      budgetKeys: ['tenant:monthly', 'user:daily'],
      metadata: { environment: 'test' },
    });
    expect(JSON.stringify(events)).not.toContain('must-not-be-captured');
    expect(JSON.stringify(events)).not.toContain('example');

    expect(events[1]).toMatchObject({
      type: 'settlement.completed',
      reservedUnits: 2,
      actualUnits: 1,
      releasedUnits: 1,
      outcome: 'success',
    });
  });

  it('emits policy and quota denials', async () => {
    const events: UsageEvent[] = [];
    const observer = collector(events);
    const denyPolicy: UsagePolicy = {
      quote(req) {
        if (req.operationId === 'policy-deny') {
          return { decision: 'deny', reason: 'plan_required' };
        }
        return { decision: 'allow', units: 1, budget: { key: 'shared', limit: 0 } };
      },
    };
    const control = new UsageControl(new MemoryUsageStore({ observer }), denyPolicy, { observer });

    await control.reserve({ ...request, operationId: 'policy-deny' });
    await control.reserve({ ...request, operationId: 'quota-deny' });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'reserve.denied', reason: 'plan_required' });
    expect(events[1]).toMatchObject({
      type: 'reserve.denied',
      reason: 'quota_exceeded',
      limitingBudgetKey: 'shared',
      remaining: 0,
    });
  });

  it('swallows observer failures and preserves enforcement results', async () => {
    const observer: UsageObserver = {
      onEvent() {
        throw new Error('telemetry backend unavailable');
      },
    };
    const control = new UsageControl(new MemoryUsageStore({ observer }), policy, { observer });

    const admission = await control.reserve(request);
    expect(admission.allowed).toBe(true);
    if (!admission.allowed) return;
    await expect(admission.lease.settle(2, 'success')).resolves.toMatchObject({
      actualUnits: 2,
      releasedUnits: 0,
    });
  });

  it('emits store errors without raw exception messages', async () => {
    const events: UsageEvent[] = [];
    const observer = collector(events);
    const failingStore = {
      reserve: async () => {
        throw new Error('redis://user:password@internal.example');
      },
      markLiable: async () => {
        throw new Error('unused');
      },
      renew: async () => {
        throw new Error('unused');
      },
      settle: async () => {
        throw new Error('unused');
      },
    };
    const control = new UsageControl(failingStore, policy, { observer });

    await expect(control.reserve(request)).rejects.toThrow('redis://user:password@internal.example');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'operation.error',
      phase: 'reserve',
      source: 'store',
      errorName: 'Error',
    });
    expect(JSON.stringify(events[0])).not.toContain('password');
    expect(JSON.stringify(events[0])).not.toContain('internal.example');
  });

  it('emits pending release and liable retention recovery events from the memory store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const events: UsageEvent[] = [];
    const observer = collector(events);
    const store = new MemoryUsageStore({ observer });
    const control = new UsageControl(store, policy, { observer });

    const pending = await control.reserve({ ...request, operationId: 'pending' });
    expect(pending.allowed).toBe(true);
    await vi.advanceTimersByTimeAsync(31);
    await control.reserve({ ...request, operationId: 'trigger-1' });

    const liable = await control.reserve({
      ...request,
      operationId: 'liable',
      principal: { ...request.principal, id: 'user-2' },
    });
    if (!liable.allowed) throw new Error('expected liable admission');
    await liable.lease.markLiable();
    await vi.advanceTimersByTimeAsync(31);
    await control.reserve({
      ...request,
      operationId: 'trigger-2',
      principal: { ...request.principal, id: 'user-3' },
    });

    const recoveries = events.filter(
      (event): event is Extract<UsageEvent, { type: 'reservation.recovered' }> =>
        event.type === 'reservation.recovered',
    );
    expect(recoveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          store: 'memory',
          recovery: 'pending_released',
          reservedUnits: 2,
          count: 1,
        }),
        expect.objectContaining({
          store: 'memory',
          recovery: 'liable_retained',
          reservedUnits: 2,
          count: 1,
        }),
      ]),
    );
  });
});
