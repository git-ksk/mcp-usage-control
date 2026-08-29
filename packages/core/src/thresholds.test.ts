import { describe, expect, it } from 'vitest';
import { projectScopedQuota } from './operational.js';
import { didUsageQuotaThresholdCross, evaluateUsageQuotaThreshold } from './thresholds.js';

describe('quota threshold helpers', () => {
  it('evaluates absolute remaining-unit thresholds', () => {
    expect(
      evaluateUsageQuotaThreshold(projectScopedQuota(10, 3), {
        kind: 'remaining_units',
        value: 3,
      }),
    ).toEqual({
      reached: true,
      exhausted: false,
      remaining: 3,
      remainingRatio: 0.3,
    });
  });

  it('evaluates percentage remaining thresholds', () => {
    expect(
      evaluateUsageQuotaThreshold(projectScopedQuota(20, 4), {
        kind: 'remaining_ratio',
        value: 0.25,
      }),
    ).toMatchObject({ reached: true, exhausted: false, remainingRatio: 0.2 });
  });

  it('fires only when a threshold is crossed, so retries do not create alert storms', () => {
    const threshold = { kind: 'remaining_units', value: 2 } as const;
    const before = projectScopedQuota(10, 3);
    const crossed = projectScopedQuota(10, 2);
    const replay = projectScopedQuota(10, 2);

    expect(didUsageQuotaThresholdCross(before, crossed, threshold)).toBe(true);
    expect(didUsageQuotaThresholdCross(crossed, replay, threshold)).toBe(false);
  });

  it('treats exhaustion as the zero threshold crossing', () => {
    const threshold = { kind: 'remaining_units', value: 0 } as const;
    expect(
      didUsageQuotaThresholdCross(
        projectScopedQuota(5, 1),
        projectScopedQuota(5, 0),
        threshold,
      ),
    ).toBe(true);
    expect(
      evaluateUsageQuotaThreshold(projectScopedQuota(5, 0), threshold),
    ).toMatchObject({ reached: true, exhausted: true });
  });

  it('requires callers to reset crossing state when accounting-window configuration changes', () => {
    expect(() =>
      didUsageQuotaThresholdCross(
        projectScopedQuota(10, 3),
        projectScopedQuota(20, 2),
        { kind: 'remaining_units', value: 2 },
      ),
    ).toThrow(RangeError);
  });

  it('rejects invalid thresholds', () => {
    expect(() =>
      evaluateUsageQuotaThreshold(projectScopedQuota(10, 5), {
        kind: 'remaining_ratio',
        value: 1.1,
      }),
    ).toThrow(RangeError);
  });
});
