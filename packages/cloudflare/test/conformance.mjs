import assert from 'node:assert/strict';
import {
  assertUsageStoreConformance,
  runProgressiveUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import { RemoteCloudflareUsageStore } from '../dist/index.js';

const endpoint =
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
const headers = { authorization: `Bearer ${token}` };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const report = await assertUsageStoreConformance({
  createStore() {
    return new RemoteCloudflareUsageStore({ endpoint, headers });
  },
  async waitForLeaseExpiry(ttlMs) {
    // Leave enough margin for HTTP/workerd scheduling on slower CI runners.
    await sleep(ttlMs + 250);
  },
  leaseTtlMs: 500,
  concurrency: 8,
});

assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
console.log(`Cloudflare portable UsageStore conformance: PASS (${endpoint})`);


const growthReport = await runProgressiveUsageStoreConformance({
  createStore() {
    return new RemoteCloudflareUsageStore({ endpoint, headers });
  },
  async waitForLeaseExpiry(ttlMs) {
    await sleep(ttlMs + 250);
  },
  leaseTtlMs: 500,
});
assert.equal(
  growthReport.passed,
  true,
  JSON.stringify(growthReport.cases.filter(result => !result.passed)),
);
console.log(`Cloudflare progressive UsageStore conformance: PASS (${endpoint})`);
