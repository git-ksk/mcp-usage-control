import { describe, expect, it } from 'vitest';
import {
  USAGE_INPUT_LIMITS,
  validateUsageBudgetEnvelope,
  validateUsageRequestEnvelope,
  validateUsageVectorEnvelope,
} from './index.js';

describe('v1 input envelope', () => {
  it('measures identifiers in UTF-8 bytes at the documented boundary', () => {
    const ascii = 'a'.repeat(USAGE_INPUT_LIMITS.identifierBytes);
    expect(() => validateUsageRequestEnvelope({
      operationId: ascii,
      principal: { id: 'principal' },
      tool: 'tool',
      args: {},
    })).not.toThrow();

    const multiByte = '界'.repeat(Math.floor(USAGE_INPUT_LIMITS.identifierBytes / 3) + 1);
    expect(() => validateUsageRequestEnvelope({
      operationId: multiByte,
      principal: { id: 'principal' },
      tool: 'tool',
      args: {},
    })).toThrow(/1024-byte input limit/);
  });

  it('bounds scalar budget topology', () => {
    const budgets = Array.from({ length: USAGE_INPUT_LIMITS.scalarBudgets }, (_, index) => ({
      key: `budget-${index}`,
      limit: 1,
    }));
    expect(() => validateUsageBudgetEnvelope(budgets)).not.toThrow();
    expect(() => validateUsageBudgetEnvelope([...budgets, { key: 'overflow', limit: 1 }]))
      .toThrow(/64-budget input limit/);
  });

  it('bounds nested vector topology before provider work', () => {
    const dimensions = Array.from({ length: USAGE_INPUT_LIMITS.vectorDimensions }, (_, index) => ({
      key: `dimension-${index}`,
      units: 1,
      budgets: [{ key: `budget-${index}`, limit: 1 }],
    }));
    expect(() => validateUsageVectorEnvelope(dimensions)).not.toThrow();
    expect(() => validateUsageVectorEnvelope([
      ...dimensions,
      { key: 'overflow', units: 1, budgets: [{ key: 'overflow-budget', limit: 1 }] },
    ])).toThrow(/32-dimension input limit/);

    expect(() => validateUsageVectorEnvelope([{
      key: 'nested',
      units: 1,
      budgets: Array.from(
        { length: USAGE_INPUT_LIMITS.vectorBudgetsPerDimension + 1 },
        (_, index) => ({ key: `nested-budget-${index}`, limit: 1 }),
      ),
    }])).toThrow(/32-budget input limit/);
  });

  it('applies the UTF-8 identifier byte limit across identifier classes without echoing rejected input', () => {
    const exact = 'a'.repeat(USAGE_INPUT_LIMITS.identifierBytes);
    const tooLarge = '界'.repeat(Math.floor(USAGE_INPUT_LIMITS.identifierBytes / 3) + 1);

    const validRequests = [
      { operationId: exact, principal: { id: 'principal' }, tool: 'tool', args: {} },
      { operationId: 'operation', principal: { id: exact }, tool: 'tool', args: {} },
      { operationId: 'operation', principal: { id: 'principal', tenantId: exact }, tool: 'tool', args: {} },
      { operationId: 'operation', principal: { id: 'principal' }, tool: exact, args: {} },
    ];
    for (const request of validRequests) expect(() => validateUsageRequestEnvelope(request)).not.toThrow();

    const invalidRequests = [
      { operationId: tooLarge, principal: { id: 'principal' }, tool: 'tool', args: {} },
      { operationId: 'operation', principal: { id: tooLarge }, tool: 'tool', args: {} },
      { operationId: 'operation', principal: { id: 'principal', tenantId: tooLarge }, tool: 'tool', args: {} },
      { operationId: 'operation', principal: { id: 'principal' }, tool: tooLarge, args: {} },
    ];
    for (const request of invalidRequests) {
      try {
        validateUsageRequestEnvelope(request);
        throw new Error('expected identifier limit rejection');
      } catch (error) {
        expect(String(error)).toMatch(/1024-byte input limit/);
        expect(String(error)).not.toContain(tooLarge);
      }
    }

    expect(() => validateUsageBudgetEnvelope([{ key: exact, limit: 1 }])).not.toThrow();
    expect(() => validateUsageVectorEnvelope([{ key: exact, units: 1, budgets: [{ key: 'budget', limit: 1 }] }])).not.toThrow();
    expect(() => validateUsageVectorEnvelope([{ key: 'dimension', units: 1, budgets: [{ key: exact, limit: 1 }] }])).not.toThrow();

    for (const action of [
      () => validateUsageBudgetEnvelope([{ key: tooLarge, limit: 1 }]),
      () => validateUsageVectorEnvelope([{ key: tooLarge, units: 1, budgets: [{ key: 'budget', limit: 1 }] }]),
      () => validateUsageVectorEnvelope([{ key: 'dimension', units: 1, budgets: [{ key: tooLarge, limit: 1 }] }]),
    ]) {
      try {
        action();
        throw new Error('expected identifier limit rejection');
      } catch (error) {
        expect(String(error)).toMatch(/1024-byte input limit/);
        expect(String(error)).not.toContain(tooLarge);
      }
    }
  });

  it('bounds total vector budget edges independently at 128', () => {
    const build = (edges: number) => {
      const dimensions = [] as Array<{ key: string; units: number; budgets: Array<{ key: string; limit: number }> }>;
      let remaining = edges;
      let dimension = 0;
      while (remaining > 0) {
        const count = Math.min(USAGE_INPUT_LIMITS.vectorBudgetsPerDimension, remaining);
        dimensions.push({
          key: `dimension-${dimension}`,
          units: 1,
          budgets: Array.from({ length: count }, (_, index) => ({
            key: `budget-${dimension}-${index}`,
            limit: 1,
          })),
        });
        remaining -= count;
        dimension += 1;
      }
      return dimensions;
    };

    expect(() => validateUsageVectorEnvelope(build(USAGE_INPUT_LIMITS.vectorBudgetsTotal))).not.toThrow();
    expect(() => validateUsageVectorEnvelope(build(USAGE_INPUT_LIMITS.vectorBudgetsTotal + 1)))
      .toThrow(/128-budget input limit/);
  });

});
