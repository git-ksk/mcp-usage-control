import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { UsageEvent } from './observability.js';
import {
  MCP_USAGE_CONTROL_VERSION,
  UsageOperationalMonitor,
  createUsageRuntimeIdentity,
  projectScopedQuota,
  projectScopedQuotaWindow,
} from './operational.js';
import { normalizeSettlementOutcome } from './settlement-outcomes.js';

describe('operational snapshot helpers', () => {
  it('keeps the exported package version aligned with package metadata', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(MCP_USAGE_CONTROL_VERSION).toBe(pkg.version);
  });

  it('builds bounded static runtime identity and deduplicates capabilities', () => {
    expect(
      createUsageRuntimeIdentity({
        provider: 'redis',
        capabilities: ['vector', 'progressive', 'vector'],
        storageSchemaVersion: 'redis-v2',
      }),
    ).toEqual({
      packageName: 'mcp-usage-control',
      packageVersion: '1.0.0',
      provider: 'redis',
      capabilities: ['progressive', 'vector'],
      storageSchemaVersion: 'redis-v2',
    });
  });

  it('projects one explicitly scoped authoritative balance without exposing an identifier', () => {
    expect(projectScopedQuota(10, 3)).toEqual({
      limit: 10,
      remaining: 3,
      used: 7,
      exhausted: false,
      utilization: 0.7,
    });
    expect(projectScopedQuota(0, 0)).toMatchObject({ exhausted: true, utilization: 1 });
    expect(() => projectScopedQuota(2, 3)).toThrow(RangeError);
    expect(projectScopedQuotaWindow(10, 0, Date.parse('2026-09-01T00:00:00Z'))).toEqual({
      limit: 10,
      remaining: 0,
      used: 10,
      exhausted: true,
      utilization: 1,
      resetsAt: Date.parse('2026-09-01T00:00:00Z'),
    });
    expect(() => projectScopedQuotaWindow(10, 1, Number.NaN)).toThrow(RangeError);
  });

  it('collects bounded lifecycle counters without inferring quota/accounting state', () => {
    const monitor = new UsageOperationalMonitor(
      createUsageRuntimeIdentity({ provider: 'memory', capabilities: ['reconciliation'] }),
    );
    const events: UsageEvent[] = [
      {
        type: 'reserve.accepted',
        timestamp: 1,
        principalId: 'p',
        tool: 't',
        operationId: 'o1',
        reservationId: 'r1',
        budgetKeys: ['private-budget-key'],
        reservedUnits: 2,
        remainingByBudget: [{ key: 'private-budget-key', remaining: 8 }],
      },
      {
        type: 'reserve.denied',
        timestamp: 2,
        principalId: 'p',
        tool: 't',
        operationId: 'o2',
        reason: 'quota_exceeded',
        limitingBudgetKey: 'private-budget-key',
        remaining: 0,
      },
      {
        type: 'operation.error',
        timestamp: 3,
        phase: 'mark_liable',
        source: 'store',
        errorName: 'Error',
      },
      {
        type: 'operation.error',
        timestamp: 4,
        phase: 'settle',
        source: 'store',
        errorName: 'Error',
      },
      {
        type: 'settlement.completed',
        timestamp: 5,
        principalId: 'p',
        tool: 't',
        operationId: 'o3',
        reservationId: 'r3',
        budgetKeys: ['private-budget-key'],
        reservedUnits: 2,
        actualUnits: 1,
        releasedUnits: 1,
        outcome: 'completed',
      },
      {
        type: 'reservation.recovered',
        timestamp: 6,
        store: 'memory',
        recovery: 'pending_released',
        reservedUnits: 2,
        count: 3,
      },
      {
        type: 'vector.reservation.recovered',
        timestamp: 7,
        store: 'memory',
        recovery: 'liable_retained',
        count: 2,
      },
    ];
    for (const event of events) monitor.onEvent(event);

    expect(() => normalizeSettlementOutcome('bad-domain-value', undefined, monitor)).toThrow();

    const snapshot = monitor.snapshot();
    expect(snapshot).toMatchObject({
      identity: {
        provider: 'memory',
        capabilities: ['reconciliation'],
      },
      lifecycle: {
        eventsObserved: 7,
        reserveAccepted: 1,
        reserveDenied: 1,
        settlementsCompleted: 1,
        pendingReservationsReleased: 3,
        liableReservationsRetained: 2,
        invalidSettlementOutcomes: 1,
        observedAttempts: {
          reserve: 2,
          settle: 2,
        },
        errors: {
          quote: 0,
          reserve: 0,
          markLiable: 1,
          renew: 0,
          settle: 1,
        },
      },
      lastEventAt: 7,
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-budget-key');
    expect(JSON.stringify(snapshot)).not.toContain('reservationId');
    expect(JSON.stringify(snapshot)).not.toContain('bad-domain-value');
  });

  it('returns detached snapshots', () => {
    const monitor = new UsageOperationalMonitor(
      createUsageRuntimeIdentity({ provider: 'custom', capabilities: ['vector'] }),
    );
    const first = monitor.snapshot();
    first.lifecycle.errors.reserve = 99;
    first.lifecycle.observedAttempts.reserve = 99;
    (first.identity!.capabilities as string[]).push('mutated');
    expect(monitor.snapshot()).toMatchObject({
      identity: { capabilities: ['vector'] },
      lifecycle: {
        observedAttempts: { reserve: 0 },
        errors: { reserve: 0 },
      },
    });
  });
});
