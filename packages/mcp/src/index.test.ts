import { describe, expect, it } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import { MemoryUsageStore, UsageControl, type UsagePolicy } from '@mcp-usage-control/core';
import { protectTool } from './index.js';

const ctx = {} as ServerContext;

const policy: UsagePolicy = {
  quote() {
    return { decision: 'allow', units: 1, budget: { key: 'monthly:user-1', limit: 1 } };
  },
};

describe('protectTool', () => {
  it('charges the full reservation on an unclassified error', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
      },
      async () => {
        throw new Error('upstream timeout');
      },
    );

    await expect(protectedHandler({}, ctx)).rejects.toThrow('upstream timeout');
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('allows an explicit zero-cost pre-execution failure classification', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        errorUnits: () => 0,
      },
      async () => {
        throw new Error('validation failed before upstream call');
      },
    );

    await expect(protectedHandler({}, ctx)).rejects.toThrow();
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next.allowed).toBe(true);
  });
});
