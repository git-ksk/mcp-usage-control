import { describe, expect, it } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  type UsageEvent,
  type UsageObserver,
  type UsagePolicy,
} from './index.js';

const policy: UsagePolicy = {
  quote() {
    return {
      decision: 'allow',
      units: 1,
      budget: { key: 'daily:user-1:2026-08-10', limit: 5 },
    };
  },
};

describe('observability replay semantics', () => {
  it('keeps settlement state idempotent while allowing repeated completion events', async () => {
    const events: UsageEvent[] = [];
    const observer: UsageObserver = {
      onEvent(event) {
        events.push(event);
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), policy, { observer });
    const admission = await control.reserve({
      operationId: 'logical-request-1',
      principal: { id: 'user-1' },
      tool: 'search',
      args: {},
    });
    if (!admission.allowed) throw new Error('expected admission');

    const first = await admission.lease.settle(1, 'success');
    const replay = await admission.lease.settle(1, 'success');
    expect(replay).toEqual(first);

    const settlements = events.filter(event => event.type === 'settlement.completed');
    expect(settlements).toHaveLength(2);
    expect(settlements[0]).toMatchObject({
      reservationId: admission.lease.reservation.id,
      actualUnits: 1,
      outcome: 'success',
    });
    expect(settlements[1]).toMatchObject({
      reservationId: admission.lease.reservation.id,
      actualUnits: 1,
      outcome: 'success',
    });
  });
});
