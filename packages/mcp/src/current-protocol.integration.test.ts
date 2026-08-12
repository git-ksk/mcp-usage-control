import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';
import {
  MemoryMcpUsageFlowStore,
  protectMultiRoundTool,
  type McpUsageRequestStatePayload,
} from './index.js';

const openHandlers: Array<{ close(): Promise<void> }> = [];
const openClients: Client[] = [];

afterEach(async () => {
  while (openClients.length > 0) await openClients.pop()!.close();
  while (openHandlers.length > 0) await openHandlers.pop()!.close();
});

describe('current MCP protocol conformance', () => {
  it('keeps one reservation across a 2026-07-28 fresh-request retry on another handler instance', async () => {
    let quoteCalls = 0;
    const policy: UsagePolicy = {
      quote() {
        quoteCalls += 1;
        return { decision: 'allow', units: 1, budget: { key: 'current-protocol', limit: 1 } };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const flowStore = new MemoryMcpUsageFlowStore();
    const stateCodec = createRequestStateCodec<McpUsageRequestStatePayload>({
      key: '0123456789abcdef0123456789abcdef',
      ttlSeconds: 60,
    });
    const entries: Array<{ node: 'a' | 'b'; round: number; requestId: string }> = [];

    const createNode = (node: 'a' | 'b') => {
      const protectedHandler = protectMultiRoundTool(
        {
          control,
          tool: 'current-confirm',
          noInput: true,
          principal: () => ({ id: 'user-1', tenantId: 'tenant-1' }),
          operationId: () => 'one-logical-operation',
          flowStore,
          suspendTtlMs: 5_000,
          requestState: { mint: payload => stateCodec.mint(payload) },
          successUnits: () => 0,
        },
        async (_args, ctx, flow) => {
          entries.push({ node, round: flow.round, requestId: String(ctx.mcpReq.id) });
          if (flow.round === 0) {
            return inputRequired({
              inputRequests: {},
              requestState: 'application-phase-one',
            });
          }
          return {
            content: [{ type: 'text' as const, text: 'completed after cross-node resume' }],
          };
        },
      );

      const handler = createMcpHandler(() => {
        const server = new McpServer(
          { name: `usage-current-${node}`, version: '1.0.0' },
          { requestState: { verify: stateCodec.verify } },
        );
        server.registerTool(
          'current-confirm',
          { description: 'Current protocol conformance test' },
          protectedHandler,
        );
        return server;
      });
      openHandlers.push(handler);
      return handler;
    };

    const nodeA = createNode('a');
    const nodeB = createNode('b');
    let toolCallRequests = 0;
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        let method: string | undefined;
        if (request.method === 'POST') {
          const text = await request.clone().text();
          try {
            const body = JSON.parse(text) as { method?: unknown };
            if (typeof body.method === 'string') method = body.method;
          } catch {
            // Let the SDK handler surface malformed protocol input.
          }
        }
        if (method === 'tools/call') {
          const target = toolCallRequests++ === 0 ? nodeA : nodeB;
          return target.fetch(request);
        }
        return nodeA.fetch(request);
      },
    });
    const client = new Client(
      { name: 'usage-current-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    openClients.push(client);

    expect(client.getProtocolEra()).toBe('modern');
    const result = await client.callTool({ name: 'current-confirm', arguments: {} });
    expect(JSON.stringify(result.content)).toContain('completed after cross-node resume');
    expect(quoteCalls).toBe(1);
    expect(toolCallRequests).toBe(2);
    expect(entries.map(({ node, round }) => ({ node, round }))).toEqual([
      { node: 'a', round: 0 },
      { node: 'b', round: 1 },
    ]);
    expect(entries[0]?.requestId).toBeDefined();
    expect(entries[1]?.requestId).toBeDefined();
    expect(entries[0]?.requestId).not.toBe(entries[1]?.requestId);

    const after = await control.reserve({
      operationId: 'after-current-flow',
      principal: { id: 'user-1', tenantId: 'tenant-1' },
      tool: 'current-confirm',
      args: undefined,
    });
    expect(after.allowed).toBe(true);
  });
});
