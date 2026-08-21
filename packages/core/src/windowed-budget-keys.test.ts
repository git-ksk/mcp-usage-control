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
