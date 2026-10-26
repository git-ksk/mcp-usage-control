/**
 * Test-only entrypoint for installing exact Cloudflare + MCPUsage candidate
 * tarballs into a CLEAN npm project. Do not deploy: fixed principal/token
 * and test-only SDK key are intentionally NOT production authentication.
 * This worker imports every SDK, UsageControl and Durable Object exclusively
 * through candidate package exports rather than repository-relative paths.
 */
import { McpServer, createMcpHandler, createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server';
import { UsageControl } from 'mcp-usage-control';
import { protectMultiRoundTool } from 'mcp-usage-control-mcp';
import { CloudflareUsageStore } from 'mcp-usage-control-cloudflare';
import { CloudflareMcpUsageFlowStore } from 'mcp-usage-control-cloudflare/mcp-flow';
export { UsageControlDurableObject } from 'mcp-usage-control-cloudflare/worker';
export { CloudflareMcpFlowDurableObject } from 'mcp-usage-control-cloudflare/mcp-flow-worker';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if ((url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
        url.pathname !== '/test/mcp-sdk' ||
        request.headers.get('authorization') !== `Bearer ${env.MCP_USAGE_TEST_TOKEN}`) {
      return new Response('test-only route unavailable', { status: 404 });
    }
    const codec = createRequestStateCodec({ key: '0123456789abcdef0123456789abcdef', ttlSeconds: 60 });
    const control = new UsageControl(
      new CloudflareUsageStore(env.USAGE_CONTROL, { domainName: 'candidate-packaged-accounting' }),
      { quote() { return { decision: 'allow', units: 1, budget: { key: 'candidate-packaged-budget', limit: 1 } }; } },
    );
    const protectedHandler = protectMultiRoundTool({
      control,
      tool: 'confirm',
      noInput: true,
      principal: () => ({ id: 'alice', tenantId: 'tenant-1' }),
      operationId: () => 'candidate-packaged-original-operation',
      flowStore: new CloudflareMcpUsageFlowStore({ namespace: env.MCP_FLOWS, domainPrefix: 'candidate-v130' }),
      suspendTtlMs: 30_000,
      requestState: { mint: payload => codec.mint(payload) },
      successUnits: () => 0,
      leaseHeartbeat: false,
    }, async (_args, _ctx, flow) => {
      if (flow.round === 0) return inputRequired({ inputRequests: {}, requestState: 'app-private-state' });
      if (flow.round !== 1 || flow.applicationRequestState !== 'app-private-state' ||
          flow.operationId !== 'candidate-packaged-original-operation') {
        throw new Error('candidate test logical state mismatch');
      }
      return { content: [{ type: 'text', text: 'Cloudflare official SDK durable resume round 1 completed' }] };
    });
    return createMcpHandler(() => {
      const server = new McpServer(
        { name: 'candidate-packaged-cloudflare', version: '1.0.0' },
        { requestState: { verify: codec.verify }, maxToolInputElements: 128 },
      );
      server.registerTool('confirm', { description: 'Test exact candidate tarball imports and Durable Object SDK flow' }, protectedHandler);
      return server;
    }, { maxRequestBodySize: 64 * 1024 }).fetch(request);
  },
};
