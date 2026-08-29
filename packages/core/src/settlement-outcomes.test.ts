import { describe, expect, it } from 'vitest';
import {
  CANONICAL_SETTLEMENT_OUTCOMES,
  InvalidSettlementOutcomeError,
  isCanonicalSettlementOutcome,
  normalizeSettlementOutcome,
} from './settlement-outcomes.js';

describe('settlement outcome normalization', () => {
  it('accepts every canonical outcome without translation', () => {
    for (const outcome of CANONICAL_SETTLEMENT_OUTCOMES) {
      expect(normalizeSettlementOutcome(outcome)).toBe(outcome);
      expect(isCanonicalSettlementOutcome(outcome)).toBe(true);
    }
  });

  it('normalizes bounded compatibility aliases', () => {
    expect(normalizeSettlementOutcome('success')).toBe('completed');
    expect(normalizeSettlementOutcome('tool_error')).toBe('completed');
    expect(normalizeSettlementOutcome('error')).toBe('dispatched_conservative');
  });

  it('supports an application-owned finite alias map', () => {
    expect(
      normalizeSettlementOutcome('invalid_browser_request', {
        invalid_browser_request: 'invalid_arguments',
      }),
    ).toBe('invalid_arguments');
  });

  it('fails invalid vocabulary with a bounded distinguishable diagnostic', () => {
    let error: unknown;
    try {
      normalizeSettlementOutcome('provider-body-with-secret-token');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidSettlementOutcomeError);
    expect(error).toMatchObject({ code: 'invalid_settlement_outcome' });
    expect(String(error)).not.toContain('provider-body-with-secret-token');
  });

  it('rejects malformed aliases rather than weakening the canonical contract', () => {
    expect(() =>
      normalizeSettlementOutcome('domain_value', {
        domain_value: 'not-canonical' as never,
      }),
    ).toThrow(InvalidSettlementOutcomeError);
  });
});
