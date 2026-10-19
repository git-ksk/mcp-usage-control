import {
  createCloudflareUsageStoreGateway,
  type CloudflareDurableObjectNamespace,
  type CloudflareGatewayAuthorize,
} from '../src/index.js';
import { createCloudflareBearerTokenAuthorizer } from '../src/auth.js';
import { createCloudflareBudgetMaintenanceGateway } from '../src/maintenance.js';
import { createReconciliableCloudflareUsageStoreGateway } from '../src/reconciliation.js';
import { CloudflareMcpUsageFlowStore, type CloudflareMcpFlowNamespace } from '../src/mcp-flow.js';
import { CloudflareUsageStore } from '../src/index.js';
import { UsageControl } from 'mcp-usage-control';
import { protectMultiRoundTool } from 'mcp-usage-control-mcp';
import { McpServer, createMcpHandler, createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server';

export { UsageControlDurableObject } from '../src/versioned-worker.js';
export { CloudflareMcpFlowDurableObject } from '../src/mcp-flow-worker.js';

interface Env {
  USAGE_CONTROL: CloudflareDurableObjectNamespace;
  MCP_FLOWS: CloudflareMcpFlowNamespace;
  MCP_USAGE_TEST_TOKEN: string;
  MCP_USAGE_TEST_PREVIOUS_TOKEN?: string;
  MCP_USAGE_ENABLE_FAULT_INJECTION?: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}


/** Real protocol test only: same-worker DO accounting and flow stores, fresh MCP factory per request. */
function officialSdkHandler(env: Env, request: Request): Promise<Response> {
  const codec = createRequestStateCodec({ key: '0123456789abcdef0123456789abcdef', ttlSeconds: 60 });
  const usage = new UsageControl(
    new CloudflareUsageStore(env.USAGE_CONTROL, { domainName: 'mcp-sdk-v130-accounting' }),
    { quote() { return { decision: 'allow' as const, units: 1, budget: { key: 'mcp-sdk-v130-budget', limit: 1 } }; } },
  );
  const flows = new CloudflareMcpUsageFlowStore({ namespace: env.MCP_FLOWS, domainPrefix: 'sdk-v130' });
  const handler = protectMultiRoundTool({
    control: usage,
    tool: 'confirm',
    noInput: true,
    principal: () => ({ id: 'alice', tenantId: 'tenant-1' }),
    operationId: () => 'sdk-flow-v130-original-operation',
    flowStore: flows,
    suspendTtlMs: 30_000,
    requestState: { mint: payload => codec.mint(payload) },
    successUnits: () => 0,
    leaseHeartbeat: false,
  }, async (_args: unknown, _ctx, flow) => {
    if (flow.round === 0) return inputRequired({ inputRequests: {}, requestState: 'app-private-state' });
    if (flow.applicationRequestState !== 'app-private-state' || flow.operationId !== 'sdk-flow-v130-original-operation') {
      throw new Error('SDK flow lost the server-trusted original state');
    }
    return { content: [{ type: 'text' as const, text: 'Cloudflare official SDK durable resume round 1 completed' }] };
  });
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: 'mcp-cloudflare-sdk-v130', version: '1.0.0' },
      { requestState: { verify: codec.verify } },
    );
    server.registerTool('confirm', { description: 'Cloudflare DO cross-request official SDK flow' }, handler);
    return server;
  }).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === '/health') return new Response('ok');

    // Fault injection requires both an explicit local-test flag and a localhost
    // request. Even if wrangler.test.jsonc is accidentally deployed, these
    // routes cannot be enabled on a workers.dev/custom-domain hostname.
    const isLocalHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (env.MCP_USAGE_ENABLE_FAULT_INJECTION === '1' && isLocalHost) {
      if (pathname === '/test/mcp-sdk') {
        if (request.headers.get('authorization') !== `Bearer ${env.MCP_USAGE_TEST_TOKEN}`) {
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
        return officialSdkHandler(env, request);
      }
      if (pathname === '/test/mcp-flow' && request.method === 'POST') {
        if (request.headers.get('authorization') !== `Bearer ${env.MCP_USAGE_TEST_TOKEN}`) {
          return jsonResponse({ error: 'unauthorized' }, 401);
        }
        const store = new CloudflareMcpUsageFlowStore({ namespace: env.MCP_FLOWS });
        try {
          const input = await request.json() as {
            action: string;
            record?: Parameters<CloudflareMcpUsageFlowStore['suspend']>[0];
            flowId?: string;
            binding?: Parameters<CloudflareMcpUsageFlowStore['consume']>[1];
          };
          if (input.action === 'suspend' && input.record) {
            await store.suspend(input.record);
            return jsonResponse({ ok: true }, 200);
          }
          if (input.action === 'consume' && input.flowId && input.binding) {
            const record = await store.consume(input.flowId, input.binding);
            return jsonResponse({ ok: true, record: record ?? null }, 200);
          }
          return jsonResponse({ error: 'invalid test request' }, 400);
        } catch {
          // Do not serialize trusted payload, ids, budget keys or backend errors.
          return jsonResponse({ error: 'flow_rejected' }, 409);
        }
      }

      if (pathname === '/test/platform-limit') {
        return jsonResponse({ error: 'simulated_platform_limit' }, 429);
      }
      if (pathname === '/test/platform-unavailable') {
        return jsonResponse({ error: 'simulated_platform_unavailable' }, 503);
      }

      const malformedAuthorize = (() => 'false') as unknown as CloudflareGatewayAuthorize;
      if (pathname === '/test/auth-truthy-usage') {
        return createCloudflareUsageStoreGateway({
          namespace: env.USAGE_CONTROL,
          domainName: 'auth-truthy-usage',
          path: pathname,
          authorize: malformedAuthorize,
        })(request);
      }
      if (pathname === '/test/auth-truthy-reconciliation') {
        return createReconciliableCloudflareUsageStoreGateway({
          namespace: env.USAGE_CONTROL,
          domainName: 'auth-truthy-reconciliation',
          path: pathname,
          authorize: malformedAuthorize,
        })(request);
      }
      if (pathname === '/test/auth-truthy-maintenance') {
        return createCloudflareBudgetMaintenanceGateway({
          namespace: env.USAGE_CONTROL,
          domainName: 'auth-truthy-maintenance',
          path: pathname,
          authorizeMaintenance: malformedAuthorize,
        })(request);
      }
    }

    const authorize = createCloudflareBearerTokenAuthorizer({
      currentToken: env.MCP_USAGE_TEST_TOKEN,
      previousToken: env.MCP_USAGE_TEST_PREVIOUS_TOKEN,
    });

    if (pathname === '/v1/usage-store-maintenance') {
      const maintenanceHandler = createCloudflareBudgetMaintenanceGateway({
        namespace: env.USAGE_CONTROL,
        domainName: 'integration-test',
        authorizeMaintenance: authorize,
      });
      return maintenanceHandler(request);
    }

    const usageHandler = createReconciliableCloudflareUsageStoreGateway({
      namespace: env.USAGE_CONTROL,
      domainName: 'integration-test',
      cleanupBatchSize: 256,
      idempotencyTtlMs: 2_000,
      authorize,
    });
    return usageHandler(request);
  },
};
