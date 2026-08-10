import type { CloudflareDurableObjectNamespace } from '../src/index.js';
import { createCloudflareBudgetMaintenanceGateway } from '../src/maintenance.js';
import { createReconciliableCloudflareUsageStoreGateway } from '../src/reconciliation.js';
export { UsageControlDurableObject } from '../src/versioned-worker.js';

interface Env {
  USAGE_CONTROL: CloudflareDurableObjectNamespace;
  MCP_USAGE_TEST_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health') return new Response('ok');

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
