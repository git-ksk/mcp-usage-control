import {
  createCloudflareUsageStoreGateway,
  type CloudflareDurableObjectNamespace,
} from '../src/index.js';
export { UsageControlDurableObject } from '../src/versioned-worker.js';

interface Env {
  USAGE_CONTROL: CloudflareDurableObjectNamespace;
  MCP_USAGE_TEST_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/health') return new Response('ok');
    const handler = createCloudflareUsageStoreGateway({
      namespace: env.USAGE_CONTROL,
      domainName: 'integration-test',
      cleanupBatchSize: 256,
      idempotencyTtlMs: 2_000,
      authorize: candidate =>
        candidate.headers.get('authorization') === `Bearer ${env.MCP_USAGE_TEST_TOKEN}`,
    });
    return handler(request);
  },
};
