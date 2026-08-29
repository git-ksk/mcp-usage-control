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
});
