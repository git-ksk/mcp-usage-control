import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { MemoryUsageStore, UsageControl, type UsagePolicy } from '@mcp-usage-control/core';
import { protectTool } from './index.js';

const openHandlers: Array<{ close(): Promise<void> }> = [];
const openClients: Client[] = [];

afterEach(async () => {
  while (openClients.length > 0) await openClients.pop()!.close();
  while (openHandlers.length > 0) await openHandlers.pop()!.close();
});

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'usage-test', version: '1.0.0' });
    register(server);
    return server;
  });
  openHandlers.push(handler);

  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: 'usage-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  openClients.push(client);
  return client;
}

describe('MCP protocol integration', () => {
  it('normalizes the SDK no-input (ctx) callback shape and preserves MCP tool errors', async () => {
    const policy: UsagePolicy = {
      quote(request) {
        expect(request.args).toBeUndefined();
        return { decision: 'allow', units: 1, budget: { key: 'shared', limit: 1 } };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const client = await connect(server => {
      server.registerTool(
        'lookup',
        { description: 'Return an MCP tool error' },
        protectTool(
          {
            control,
            tool: 'lookup',
            principal: ctx => {
              expect(ctx.mcpReq.method).toBe('tools/call');
              return { id: 'user-1' };
            },
            operationId: (args, ctx) => {
              expect(args).toBeUndefined();
              return String(ctx.mcpReq.id);
            },
            toolErrorUnits: ({ args }) => {
              expect(args).toBeUndefined();
              return 0;
            },
          },
          async (args, ctx) => {
            expect(args).toBeUndefined();
            expect(ctx.mcpReq.method).toBe('tools/call');
            return {
              content: [{ type: 'text' as const, text: 'not found' }],
              isError: true,
            };
          },
        ),
      );
    });

    const result = await client.callTool({ name: 'lookup', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not found');

    const next = await control.reserve({
      operationId: 'after-tool-error',
      principal: { id: 'user-1' },
      tool: 'lookup',
      args: {},
    });
    expect(next.allowed).toBe(true);
  });

  it('does not expose internal policy denial reasons through the SDK tool error', async () => {
    const policy: UsagePolicy = {
      quote() {
        return { decision: 'deny', reason: 'internal:tenant-budget-secret' };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const client = await connect(server => {
      server.registerTool(
        'blocked',
        { description: 'Always denied' },
        protectTool(
          {
            control,
            tool: 'blocked',
            principal: () => ({ id: 'user-1' }),
            operationId: (_args, ctx) => String(ctx.mcpReq.id),
          },
          async () => ({ content: [{ type: 'text' as const, text: 'should not run' }] }),
        ),
      );
    });

    const result = await client.callTool({ name: 'blocked', arguments: {} });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('Usage denied by usage policy');
    expect(text).not.toContain('tenant-budget-secret');
  });

  it('surfaces input_required as an explicit unsupported flow instead of settling it as success', async () => {
    const policy: UsagePolicy = {
      quote() {
        return { decision: 'allow', units: 1, budget: { key: 'shared', limit: 1 } };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const client = await connect(server => {
      server.registerTool(
        'confirm',
        { description: 'Simulate a multi-round tool' },
        protectTool(
          {
            control,
            tool: 'confirm',
            principal: () => ({ id: 'user-1' }),
            operationId: (_args, ctx) => String(ctx.mcpReq.id),
          },
          async () =>
            ({
              resultType: 'input_required',
              inputRequests: {},
            }) as never,
        ),
      );
    });

    const result = await client.callTool({ name: 'confirm', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('input_required');
  });
});
