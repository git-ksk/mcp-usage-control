import { describe, expect, it } from 'vitest';
import { projectUsageEvent, type UsageEvent } from './observability.js';

const identity = {
  principalId: 'user-secret-123',
  tenantId: 'tenant-secret-456',
  plan: 'private-plan-name',
  tool: 'customer-specific-tool-secret',
  operationId: 'operation-secret-789',
};

describe('projectUsageEvent', () => {
  it('projects accepted admissions without identity or budget identifiers', () => {
    const event: UsageEvent = {
      type: 'reserve.accepted',
      timestamp: 1,
      ...identity,
      reservationId: 'reservation-secret-1',
      budgetKeys: ['budget:user-secret-123:daily', 'budget:tenant-secret-456:monthly'],
      reservedUnits: 3,
      remainingByBudget: [
        { key: 'budget:user-secret-123:daily', remaining: 7 },
        { key: 'budget:tenant-secret-456:monthly', remaining: 97 },
      ],
    };

    const projected = projectUsageEvent(event);

    expect(projected).toEqual({
      timestamp: 1,
      eventType: 'reserve.accepted',
      phase: 'reserve',
      result: 'success',
      reservedUnits: 3,
      budgetCount: 2,
      remainingMin: 7,
      remainingMax: 97,
    });
    const serialized = JSON.stringify(projected);
    for (const secret of [
      identity.principalId,
      identity.tenantId,
      identity.plan,
      identity.tool,
      identity.operationId,
      event.reservationId,
      ...event.budgetKeys,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('normalizes application denial reasons instead of logging raw text', () => {
    const event: UsageEvent = {
      type: 'reserve.denied',
      timestamp: 2,
      ...identity,
      reason: 'customer-secret-plan:user-secret-123',
      limitingBudgetKey: 'secret-budget-key',
      remaining: 0,
    };

    const projected = projectUsageEvent(event);

    expect(projected).toEqual({
      timestamp: 2,
      eventType: 'reserve.denied',
      phase: 'reserve',
      result: 'denied',
      denialReason: 'policy_denied',
      remaining: 0,
    });
    expect(JSON.stringify(projected)).not.toContain(event.reason);
    expect(JSON.stringify(projected)).not.toContain('secret-budget-key');
  });

  it.each(['quota_exceeded', 'duplicate_operation'] as const)(
    'retains bounded built-in denial reason %s',
    reason => {
      const projected = projectUsageEvent({
        type: 'reserve.denied',
        timestamp: 3,
        ...identity,
        reason,
      });
      expect(projected.denialReason).toBe(reason);
    },
  );

  it('excludes settlement outcome and maps unknown error classes to a bounded bucket', () => {
    const settlement = projectUsageEvent({
      type: 'settlement.completed',
      timestamp: 4,
      ...identity,
      reservationId: 'reservation-secret-2',
      budgetKeys: ['budget-secret'],
      reservedUnits: 5,
      actualUnits: 4,
      releasedUnits: 1,
      outcome: 'customer-secret-outcome-123',
    });
    const failure = projectUsageEvent({
      type: 'operation.error',
      timestamp: 5,
      ...identity,
      reservationId: 'reservation-secret-3',
      phase: 'settle',
      source: 'store',
      errorName: 'CustomerSpecificProviderError',
    });

    expect(settlement).toEqual({
      timestamp: 4,
      eventType: 'settlement.completed',
      phase: 'settle',
      result: 'success',
      reservedUnits: 5,
      actualUnits: 4,
      releasedUnits: 1,
    });
    expect(JSON.stringify(settlement)).not.toContain('customer-secret-outcome-123');
    expect(failure).toEqual({
      timestamp: 5,
      eventType: 'operation.error',
      phase: 'settle',
      result: 'error',
      source: 'store',
      errorClass: 'OtherError',
    });
  });

  it('excludes recovery identifiers while retaining bounded operational fields', () => {
    const projected = projectUsageEvent({
      type: 'reservation.recovered',
      timestamp: 6,
      store: 'cloudflare',
      recovery: 'liable_retained',
      reservationId: 'opaque-but-high-cardinality-id',
      principalId: 'user-secret',
      tenantId: 'tenant-secret',
      tool: 'tool-secret',
      budgetIdentifiers: ['budget-secret'],
      reservedUnits: 9,
      count: 2,
    });

    expect(projected).toEqual({
      timestamp: 6,
      eventType: 'reservation.recovered',
      phase: 'recovery',
      result: 'recovery',
      store: 'cloudflare',
      recovery: 'liable_retained',
      reservedUnits: 9,
      count: 2,
    });
  });

  it('copies explicit metadata only when callers opt in', () => {
    const event: UsageEvent = {
      type: 'reserve.denied',
      timestamp: 7,
      ...identity,
      reason: 'plan_required',
      metadata: { environment: 'prod', regionClass: 'primary' },
    };

    expect(projectUsageEvent(event)).not.toHaveProperty('metadata');
    expect(projectUsageEvent(event, { includeMetadata: true })).toMatchObject({
      metadata: { environment: 'prod', regionClass: 'primary' },
    });
  });
});
