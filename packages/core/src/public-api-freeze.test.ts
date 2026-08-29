import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  UsageLease,
  VectorUsageLease,
  type SettleInput,
  type SettlementResult,
  type UsageStore,
  type VectorSettleInput,
  type VectorSettlementResult,
  type VectorUsageStore,
} from './index.js';
import {
  InvalidSettlementOutcomeError,
  normalizeSettlementOutcome,
} from './settlement-outcomes.js';

function scalarStore(): UsageStore {
  return {
    async reserve() {
      throw new Error('not used');
    },
    async markLiable() {
      throw new Error('not used');
    },
    async renew() {
      throw new Error('not used');
    },
    async settle(input: SettleInput): Promise<SettlementResult> {
      return {
        reservationId: input.reservationId,
        reservedUnits: 1,
        actualUnits: input.actualUnits,
        releasedUnits: 1 - input.actualUnits,
        outcome: input.outcome,
      };
    },
  };
}

function vectorStore(): VectorUsageStore {
  return {
    ...scalarStore(),
    async reserveVector() {
      throw new Error('not used');
    },
    async growVectorReservation() {
      throw new Error('not used');
    },
    async settleVector(input: VectorSettleInput): Promise<VectorSettlementResult> {
      return {
        reservationId: input.reservationId,
        dimensions: input.actualByDimension.map(item => ({
          key: item.key,
          reservedUnits: 1,
          actualUnits: item.actualUnits,
          releasedUnits: 1 - item.actualUnits,
        })),
        outcome: input.outcome,
      };
    },
  };
}

describe('v1 settlement outcome extension boundary', () => {
  it('keeps scalar and vector Store/lease outcomes intentionally extensible strings', async () => {
    expectTypeOf<SettleInput['outcome']>().toEqualTypeOf<string>();
    expectTypeOf<VectorSettleInput['outcome']>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<UsageLease['settle']>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<VectorUsageLease['settle']>[1]>().toEqualTypeOf<string>();

    const scalar = new UsageLease(
      scalarStore(),
      {
        id: 'scalar-reservation',
        operationId: 'scalar-op',
        principalId: 'user-1',
        tool: 'custom-tool',
        budgetKeys: ['custom-budget'],
        reservedUnits: 1,
        expiresAt: Date.now() + 60_000,
      },
      60_000,
    );
    await expect(scalar.settle(1, 'application_specific_completed')).resolves.toMatchObject({
      outcome: 'application_specific_completed',
    });

    const vector = new VectorUsageLease(
      vectorStore(),
      {
        id: 'vector-reservation',
        operationId: 'vector-op',
        principalId: 'user-1',
        tool: 'custom-vector-tool',
        dimensions: [{ key: 'requests', budgetKeys: ['vector-budget'], reservedUnits: 1 }],
        expiresAt: Date.now() + 60_000,
      },
      60_000,
    );
    await expect(
      vector.settle([{ key: 'requests', actualUnits: 1 }], 'application_specific_completed'),
    ).resolves.toMatchObject({ outcome: 'application_specific_completed' });
  });

  it('keeps canonical normalization as the bounded integration vocabulary', () => {
    expect(normalizeSettlementOutcome('success')).toBe('completed');
    expect(normalizeSettlementOutcome('tool_error')).toBe('completed');
    expect(normalizeSettlementOutcome('error')).toBe('dispatched_conservative');
    expect(() => normalizeSettlementOutcome('application_specific_completed')).toThrow(
      InvalidSettlementOutcomeError,
    );
  });
});
