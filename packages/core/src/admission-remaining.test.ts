import { describe, expect, it } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  type BudgetRemaining,
  type UsageStore,
} from './index.js';

const request = {
  operationId: 'op-remaining',
  principal: { id: 'user-1' },
  tool: 'search',
  args: {},
};

describe('successful admission remaining budgets', () => {
  it('exposes the authoritative store result without recomputing it', async () => {
    const storeRemaining: BudgetRemaining[] = [{ key: 'daily', remaining: 37 }];
    const store: UsageStore = {
      reserve: async input => ({
        accepted: true,
        reservation: {
          id: 'reservation-1',
          operationId: input.request.operationId,
          principalId: input.request.principal.id,
          tool: input.request.tool,
          budgetKeys: input.budgets.map(budget => budget.key),
          reservedUnits: input.units,
          expiresAt: Date.now() + input.ttlMs,
        },
        remainingByBudget: storeRemaining,
      }),
      markLiable: async () => {
        throw new Error('not used');
      },
      renew: async () => {
        throw new Error('not used');
      },
      settle: async () => {
        throw new Error('not used');
      },
    };
    const control = new UsageControl(store, {
      quote: () => ({ decision: 'allow', units: 3, budget: { key: 'daily', limit: 100 } }),
    });

    const admission = await control.reserve(request);

    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error('expected admission');
    expect(admission.remainingByBudget).toEqual([{ key: 'daily', remaining: 37 }]);

    storeRemaining[0]!.remaining = 0;
    expect(admission.remainingByBudget).toEqual([{ key: 'daily', remaining: 37 }]);
  });

  it('preserves canonical multi-budget ordering from the store', async () => {
    const control = new UsageControl(new MemoryUsageStore(), {
      quote: () => ({
        decision: 'allow',
        units: 2,
        budgets: [
          { key: 'user:daily', limit: 10 },
          { key: 'tenant:daily', limit: 20 },
        ],
      }),
    });

    const admission = await control.reserve({ ...request, operationId: 'op-multi' });

    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error('expected admission');
    expect(admission.remainingByBudget).toEqual([
      { key: 'tenant:daily', remaining: 18 },
      { key: 'user:daily', remaining: 8 },
    ]);
  });
});
