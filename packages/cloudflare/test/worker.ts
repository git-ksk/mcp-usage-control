import type { CloudflareDurableObjectNamespace } from '../src/index.js';
import { createCloudflareBudgetMaintenanceGateway } from '../src/maintenance.js';
import { createReconciliableCloudflareUsageStoreGateway } from '../src/reconciliation.js';
export { UsageControlDurableObject } from '../src/versioned-worker.js';

interface Env {
  USAGE_CONTROL: CloudflareDurableObjectNamespace;
  MCP_USAGE_TEST_TOKEN: string;
  MCP_USAGE_ENABLE_FAULT_INJECTION?: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
      if (pathname === '/test/platform-limit') {
        return jsonResponse({ error: 'simulated_platform_limit' }, 429);
      }
      if (pathname === '/test/platform-unavailable') {
        return jsonResponse({ error: 'simulated_platform_unavailable' }, 503);
      }
    }

    if (pathname === '/v1/usage-store-maintenance') {
      const maintenanceHandler = createCloudflareBudgetMaintenanceGateway({
        namespace: env.USAGE_CONTROL,
        domainName: 'integration-test',
        authorizeMaintenance: candidate =>
          candidate.headers.get('authorization') === `Bearer ${env.MCP_USAGE_TEST_TOKEN}`,
      });
      return maintenanceHandler(request);
    }

    const usageHandler = createReconciliableCloudflareUsageStoreGateway({
      namespace: env.USAGE_CONTROL,
      domainName: 'integration-test',
      cleanupBatchSize: 256,
      idempotencyTtlMs: 2_000,
      authorize: candidate =>
        candidate.headers.get('authorization') === `Bearer ${env.MCP_USAGE_TEST_TOKEN}`,
    });
    return usageHandler(request);
  },
};
