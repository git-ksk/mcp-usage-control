import { describe, expect, it } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  createWeightedCreditsPolicy,
  createWindowedBudgetKey,
  type UsageRequest,
} from './index.js';

function request(operationId: string, plan: 'free' | 'plus'): UsageRequest {
  return { operationId, principal: { id: 'u:42', plan }, tool: 'analyze', args: {} };
}

describe('windowed budget keys', () => {
  it('derives a deterministic Tokyo calendar-day key across the UTC date boundary', () => {
    const daily = createWindowedBudgetKey({
      period: 'calendar-day',
      timeZone: 'Asia/Tokyo',
      namespace: 'credits',
    });

    expect(daily.key({ scope: 'user', id: '42', now: Date.parse('2026-08-21T14:59:59.999Z') }))
      .toBe('credits:day:tz=Asia%2FTokyo:user:42:2026-08-21');
    expect(daily.key({ scope: 'user', id: '42', now: Date.parse('2026-08-21T15:00:00.000Z') }))
      .toBe('credits:day:tz=Asia%2FTokyo:user:42:2026-08-22');
  });

  it('derives month identity in the configured time zone, including leap-day transitions', () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'America/New_York',
      namespace: 'credits',
    });

    expect(monthly.key({ scope: 'tenant', id: 'acme', now: Date.parse('2028-03-01T04:59:59.999Z') }))
      .toBe('credits:month:tz=America%2FNew_York:tenant:acme:2028-02');
    expect(monthly.key({ scope: 'tenant', id: 'acme', now: Date.parse('2028-03-01T05:00:00.000Z') }))
      .toBe('credits:month:tz=America%2FNew_York:tenant:acme:2028-03');
  });

  it('uses an injectable clock and lets an explicit now override it', () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'UTC',
      namespace: 'credits',
      clock: () => new Date('2026-08-31T23:59:59.999Z'),
    });

    expect(monthly.key({ scope: 'user', id: '42' })).toBe('credits:month:tz=UTC:user:42:2026-08');
    expect(monthly.key({ scope: 'user', id: '42', now: new Date('2026-09-01T00:00:00.000Z') }))
      .toBe('credits:month:tz=UTC:user:42:2026-09');
  });


  it('projects matching daily boundaries across DST spring-forward and fall-back days', () => {
    const daily = createWindowedBudgetKey({
      period: 'calendar-day',
      timeZone: 'America/New_York',
      namespace: 'requests',
    });

    const spring = daily.window({
      scope: 'user',
      id: '42',
      now: Date.parse('2026-03-08T12:00:00Z'),
    });
    expect(spring).toEqual({
      key: 'requests:day:tz=America%2FNew_York:user:42:2026-03-08',
      startsAt: Date.parse('2026-03-08T05:00:00.000Z'),
      endsAt: Date.parse('2026-03-09T04:00:00.000Z'),
    });
    expect(spring.endsAt - spring.startsAt).toBe(23 * 60 * 60 * 1000);

    const fall = daily.window({
      scope: 'user',
      id: '42',
      now: Date.parse('2026-11-01T12:00:00Z'),
    });
    expect(fall).toEqual({
      key: 'requests:day:tz=America%2FNew_York:user:42:2026-11-01',
      startsAt: Date.parse('2026-11-01T04:00:00.000Z'),
      endsAt: Date.parse('2026-11-02T05:00:00.000Z'),
    });
    expect(fall.endsAt - fall.startsAt).toBe(25 * 60 * 60 * 1000);
  });

  it('projects month/year rollover boundaries from the same key calculation', () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'Asia/Tokyo',
      namespace: 'credits',
    });

    expect(monthly.window({
      scope: 'tenant',
      id: 'acme',
      now: Date.parse('2026-12-15T00:00:00Z'),
    })).toEqual({
      key: 'credits:month:tz=Asia%2FTokyo:tenant:acme:2026-12',
      startsAt: Date.parse('2026-11-30T15:00:00.000Z'),
      endsAt: Date.parse('2026-12-31T15:00:00.000Z'),
    });
  });

  it('uses the same explicit-now precedence for key and window projection', () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'UTC',
      namespace: 'credits',
      clock: () => Date.parse('2026-08-15T12:00:00Z'),
    });

    expect(monthly.window({ scope: 'user', id: '42' })).toMatchObject({
      key: 'credits:month:tz=UTC:user:42:2026-08',
      startsAt: Date.parse('2026-08-01T00:00:00Z'),
      endsAt: Date.parse('2026-09-01T00:00:00Z'),
    });
    expect(monthly.window({
      scope: 'user',
      id: '42',
      now: Date.parse('2026-09-15T12:00:00Z'),
    })).toMatchObject({
      key: 'credits:month:tz=UTC:user:42:2026-09',
      startsAt: Date.parse('2026-09-01T00:00:00Z'),
      endsAt: Date.parse('2026-10-01T00:00:00Z'),
    });
  });

  it('encodes namespace, scope, and id so delimiters cannot collide', () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'UTC',
      namespace: 'credit:pool',
    });

    const first = monthly.key({ scope: 'user', id: 'a:b', now: 0 });
    const second = monthly.key({ scope: 'user:a', id: 'b', now: 0 });
    expect(first).toBe('credit%3Apool:month:tz=UTC:user:a%3Ab:1970-01');
    expect(second).toBe('credit%3Apool:month:tz=UTC:user%3Aa:b:1970-01');
    expect(first).not.toBe(second);
  });

  it('makes time-zone changes explicit accounting identity changes', () => {
    const utc = createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'UTC', namespace: 'credits' });
    const tokyo = createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'Asia/Tokyo', namespace: 'credits' });
    const now = Date.parse('2026-08-10T00:00:00Z');

    expect(utc.key({ scope: 'user', id: '42', now }))
      .toBe('credits:month:tz=UTC:user:42:2026-08');
    expect(tokyo.key({ scope: 'user', id: '42', now }))
      .toBe('credits:month:tz=Asia%2FTokyo:user:42:2026-08');
  });

  it('fails closed for invalid configuration and malformed key inputs', () => {
    expect(() => createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'Not/AZone', namespace: 'credits' }))
      .toThrow(RangeError);
    expect(() => createWindowedBudgetKey({ period: 'rolling-month' as never, timeZone: 'UTC', namespace: 'credits' }))
      .toThrow(/calendar-day/);
    expect(() => createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'UTC', namespace: ' ' }))
      .toThrow(TypeError);
    expect(() => createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'UTC', namespace: 'credits', extra: true } as never))
      .toThrow(/unknown field/);

    const monthly = createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'UTC', namespace: 'credits' });
    expect(() => monthly.key({ scope: 'user', id: '42' })).toThrow(/input.now is required/);
    expect(() => monthly.key({ scope: '', id: '42', now: 0 })).toThrow(TypeError);
    expect(() => monthly.key({ scope: 'user', id: '42', now: Number.NaN })).toThrow(RangeError);
    expect(() => monthly.key({ scope: 'user', id: '42', now: new Date(Number.NaN) })).toThrow(RangeError);
    expect(() => monthly.key({ scope: 'user', id: '42', extra: true } as never)).toThrow(/unknown field/);
  });

  it('selects a fresh Store bucket on rollover without mutating the previous window', async () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'UTC',
      namespace: 'credits',
    });
    const store = new MemoryUsageStore();

    const policyAt = (now: number) => createWeightedCreditsPolicy({
      config: {
        tools: { analyze: 30 },
        plans: { free: { limits: { monthly: 50 } } },
        unknownTool: 'deny',
      },
      budgets: ({ request: req, limit }) => ({
        key: monthly.key({ scope: 'user', id: req.principal.id, now }),
        limit: limit('monthly'),
      }),
    });

    const august = new UsageControl(store, policyAt(Date.parse('2026-08-31T23:59:59.999Z')));
    const augustAdmission = await august.reserve(request('op:august', 'free'));
    expect(augustAdmission.allowed).toBe(true);
    if (!augustAdmission.allowed) throw new Error('expected August admission');
    await augustAdmission.lease.markLiable();
    await augustAdmission.lease.settle(30, 'completed');

    const september = new UsageControl(store, policyAt(Date.parse('2026-09-01T00:00:00.000Z')));
    const septemberAdmission = await september.reserve(request('op:september', 'free'));
    expect(septemberAdmission.allowed).toBe(true);
    if (!septemberAdmission.allowed) throw new Error('expected September admission');
    expect(septemberAdmission.remainingByBudget).toEqual([{
      key: 'credits:month:tz=UTC:user:u%3A42:2026-09',
      remaining: 20,
    }]);
    await septemberAdmission.lease.markLiable();
    await septemberAdmission.lease.settle(30, 'completed');

    const augustAgain = await august.reserve(request('op:august-again', 'free'));
    expect(augustAgain).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: 'credits:month:tz=UTC:user:u%3A42:2026-08',
      remaining: 20,
    });
  });

  it('keeps progressive growth pinned to the reservation budget across a window boundary', async () => {
    let now = Date.parse('2026-08-31T23:59:59.999Z');
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'UTC',
      namespace: 'credits',
      clock: () => now,
    });
    const policy = createWeightedCreditsPolicy({
      config: {
        tools: { analyze: 10 },
        plans: { free: { limits: { monthly: 50 } } },
        unknownTool: 'deny',
      },
      budgets: ({ request: req, limit }) => ({
        key: monthly.key({ scope: 'user', id: req.principal.id }),
        limit: limit('monthly'),
      }),
    });
    const control = new UsageControl(new MemoryUsageStore(), policy);

    const admission = await control.reserve(request('op:cross-window-growth', 'free'));
    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error('expected initial admission');
    const originalBudget = admission.remainingByBudget[0];
    if (!originalBudget) throw new Error('expected one reservation budget');
    expect(originalBudget.key).toBe('credits:month:tz=UTC:user:u%3A42:2026-08');

    now = Date.parse('2026-09-01T00:00:00.000Z');
    const rederivedBudgetKey = monthly.key({ scope: 'user', id: 'u:42' });
    expect(rederivedBudgetKey).toBe('credits:month:tz=UTC:user:u%3A42:2026-09');

    await expect(admission.lease.grow({
      incrementId: 'batch-rederived-after-rollover',
      additionalUnits: 10,
      budgets: [{ key: rederivedBudgetKey, limit: 50 }],
    })).rejects.toThrow('Growth budgets must exactly match the reservation budget set');

    const growth = await admission.lease.grow({
      incrementId: 'batch-0001',
      additionalUnits: 10,
      budgets: [{ key: originalBudget.key, limit: 50 }],
    });
    expect(growth.accepted).toBe(true);
    if (!growth.accepted) throw new Error('expected pinned-key growth admission');
    expect(growth.reservedUnits).toBe(20);
  });

  it('composes with weighted credits without resetting usage on a same-window plan change', async () => {
    const monthly = createWindowedBudgetKey({
      period: 'calendar-month',
      timeZone: 'Asia/Tokyo',
      namespace: 'credits',
      clock: () => Date.parse('2026-08-22T03:00:00+09:00'),
    });
    const policy = createWeightedCreditsPolicy({
      config: {
        tools: { analyze: 30 },
        plans: {
          free: { limits: { monthly: 50 } },
          plus: { limits: { monthly: 100 } },
        },
        unknownTool: 'deny',
      },
      budgets: ({ request: req, limit }) => ({
        key: monthly.key({ scope: 'user', id: req.principal.id }),
        limit: limit('monthly'),
      }),
    });
    const control = new UsageControl(new MemoryUsageStore(), policy);

    const free = await control.reserve(request('op:free', 'free'));
    expect(free.allowed).toBe(true);
    if (!free.allowed) throw new Error('expected free admission');
    await free.lease.markLiable();
    await free.lease.settle(30, 'completed');

    const plus = await control.reserve(request('op:plus', 'plus'));
    expect(plus.allowed).toBe(true);
    if (!plus.allowed) throw new Error('expected plus admission');
    expect(plus.remainingByBudget).toEqual([{
      key: 'credits:month:tz=Asia%2FTokyo:user:u%3A42:2026-08',
      remaining: 40,
    }]);
  });
});
