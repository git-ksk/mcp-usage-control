import { describe, expect, it } from 'vitest';
import { UsageDeniedError, getUsageDenialContext } from './index.js';

describe('UsageDeniedError server-private admission context', () => {
  it('keeps the stable public error contract and never serializes budget identities', () => {
    const key = 'private:principal-123:tenant-456:daily:secret';
    const error = new UsageDeniedError('quota_exceeded', { limitingBudgetKey: key, remaining: 0 });
    expect(error.name).toBe('UsageDeniedError');
    expect(error.reason).toBe('quota_exceeded');
    expect(error.message).toBe('Usage denied by usage policy');
    expect(JSON.stringify(error)).not.toContain(key);
    expect(Object.keys(error)).not.toContain('limitingBudgetKey');
    expect(Object.keys(error)).not.toContain('remaining');
    expect(getUsageDenialContext(error)).toEqual({ limitingBudgetKey: key, remaining: 0 });
    expect(String(error)).not.toContain(key);
  });

  it('does not create retry-time promises or leak the diagnostic to unrelated failures', () => {
    expect(getUsageDenialContext(new UsageDeniedError('plan_required'))).toBeUndefined();
    expect(getUsageDenialContext(new Error('quota_exceeded'))).toBeUndefined();
    expect(getUsageDenialContext({ reason: 'quota_exceeded' })).toBeUndefined();
    const denial = new UsageDeniedError('duplicate_operation', {});
    expect(getUsageDenialContext(denial)).toEqual({});
    expect(getUsageDenialContext(denial)).not.toHaveProperty('retryAfter');
  });

  it('returns a defensive copy rather than exposing its trusted internal diagnostic', () => {
    const denial = new UsageDeniedError('quota_exceeded', { limitingBudgetKey: 'private-a', remaining: 1 });
    const copy = getUsageDenialContext(denial)! as { limitingBudgetKey: string };
    copy.limitingBudgetKey = 'tampered';
    expect(getUsageDenialContext(denial)?.limitingBudgetKey).toBe('private-a');
  });

  it('rejects malformed server contexts before they can propagate', () => {
    expect(() => new UsageDeniedError('quota_exceeded', { remaining: -1 })).toThrow(/remaining/);
    expect(() => new UsageDeniedError('quota_exceeded', { limitingBudgetKey: '' })).toThrow(/limitingBudgetKey/);
  });
});
