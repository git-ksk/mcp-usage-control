import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MemoryUsageStore, UsageControl } from 'mcp-usage-control';
import { protectTool } from 'mcp-usage-control-mcp';

// Local-only fixture: all callers share this test principal. Real applications MUST
// authenticate the caller and obtain the principal/tenant from trusted server state.
const DEMO_PRINCIPAL = Object.freeze({ id: 'example-user', tenantId: 'example-tenant' });
const MAX_REQUEST_BYTES = 64 * 1024;

// The official MCP SDK can serialize thrown Error.message to the client.
// Keep raw Store/classification errors in the trusted server boundary only.
// A product may attach its own access-controlled diagnostics here, but must
// NEVER expose raw exception messages, principal IDs or budget keys on the wire.
function sanitizeClientErrors(handler, onProtectedError) {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      try { await onProtectedError?.(error); } catch { /* diagnostics are best-effort */ }
      return {
        content: [{ type: 'text', text: 'Usage denied or tool unavailable' }],
        isError: true,
      };
    }
  };
}

export async function startExampleServer({
  budgetLimit = 8,
  createStore = () => new MemoryUsageStore(),
  onHandlerEntry,
  classifySuccessUnits,
  onProtectedError,
} = {}) {
  const metrics = { handlerEntries: 0, quotes: 0 };
  const store = createStore();
  const control = new UsageControl(store, {
    quote({ principal, tool }) {
      metrics.quotes += 1;
      if (tool !== 'demo-report') return { decision: 'deny', reason: 'unsupported_tool' };
      return {
        decision: 'allow',
        units: 5, // Safe maximum; known successes settle only 3 units.
        budget: { key: `local-demo:${principal.tenantId}:${principal.id}`, limit: budgetLimit },
      };
    },
  });

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'usage-control-example', version: '1.0.0' });
    server.registerTool(
      'demo-report',
      {
        description: 'Simulate a metered report (no paid calls or external side effects)',
        inputSchema: z.object({
          actionId: z.string().uuid(),
          mode: z.enum(['ok', 'unknown-cost', 'tool-error']),
        }).strict(),
      },
      sanitizeClientErrors(protectTool(
        {
          control,
          tool: 'demo-report',
          principal: () => DEMO_PRINCIPAL,
          // For THIS demo the client supplies a validated, per-action UUID. It is
          // scoped by the trusted principal above, NOT proof of authentication.
          // A production app must define the ID's lifecycle, or use a fresh
          // server UUID for each ordinary dispatch without a stable action key.
          operationId: args => args.actionId,
          successUnits: ({ result }) => classifySuccessUnits ? classifySuccessUnits(result) : result.actualUnits,
        },
        async ({ mode }) => {
          metrics.handlerEntries += 1;
          await onHandlerEntry?.();
          if (mode === 'unknown-cost') {
            // After handler entry usage is cost-liable: default error settlement
            // conservatively charges the full 5-unit reservation.
            throw new Error('example simulated metered-work failure');
          }
          if (mode === 'tool-error') {
            return { content: [{ type: 'text', text: 'Local tool error' }], isError: true };
          }
          return {
            content: [{ type: 'text', text: 'Local example report' }],
            actualUnits: 3,
          };
        },
      ), onProtectedError),
    );
    return server;
  });

  const http = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_REQUEST_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const fetchRequest = new Request('http://127.0.0.1/mcp', {
        method: request.method,
        headers: request.headers,
        ...(body === undefined ? {} : { body }),
      });
      const result = await handler.fetch(fetchRequest);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) {
        await pipeline(Readable.fromWeb(result.body), response);
      } else {
        response.end();
      }
    } catch {
      // Never reflect raw Store/SDK exceptions, policy details, or identities.
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });

  try {
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback address');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    metrics,
    control,
    async close() {
      await handler.close();
      await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    },
  };
}
