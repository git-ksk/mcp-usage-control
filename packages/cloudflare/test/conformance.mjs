import assert from 'node:assert/strict';
import {
  assertUsageStoreConformance,
  runProgressiveUsageStoreConformance,
  runVectorUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import { CloudflareUsageTransportError, RemoteCloudflareUsageStore } from '../dist/index.js';

const endpoint =
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
const headers = { authorization: `Bearer ${token}` };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const transportFailures = [];

// Only bounded transport classifications go to CI logs. Never log request
// bodies, auth headers, budget keys, principal IDs or raw SDK/Store errors.
function monitoredStore() {
  const store = new RemoteCloudflareUsageStore({ endpoint, headers });
  return new Proxy(store, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== 'function') return method;
      return async (...args) => {
        const started = performance.now();
        try {
          return await method.apply(target, args);
        } catch (error) {
          if (error instanceof CloudflareUsageTransportError) {
            transportFailures.push({
              method: String(property),
              code: error.code,
              status: Number.isInteger(error.status) ? error.status : null,
              elapsedMs: Math.round(performance.now() - started),
            });
          }
          throw error;
        }
      };
    },
  });
}

function reportTransportFailures(phase) {
  if (transportFailures.length === 0) return;
  // Cap diagnostics even when many operations fail in one concurrency test.
  console.error(JSON.stringify({
    phase,
    transportFailures: transportFailures.length,
    firstFailures: transportFailures.slice(0, 16),
  }));
  transportFailures.length = 0;
}

let report;
try {
  report = await assertUsageStoreConformance({
  createStore() {
    return monitoredStore();
  },
  async waitForLeaseExpiry(ttlMs) {
    // Leave enough margin for HTTP/workerd scheduling on slower CI runners.
    await sleep(ttlMs + 250);
  },
  leaseTtlMs: 500,
  concurrency: 8,
  });
} catch (error) {
  reportTransportFailures('scalar');
  throw error;
}

assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
console.log(`Cloudflare portable UsageStore conformance: PASS (${endpoint})`);


const growthReport = await runProgressiveUsageStoreConformance({
  createStore() {
    return monitoredStore();
  },
  async waitForLeaseExpiry(ttlMs) {
    await sleep(ttlMs + 250);
  },
  leaseTtlMs: 500,
});
if (!growthReport.passed) reportTransportFailures('progressive');
assert.equal(
  growthReport.passed,
  true,
  JSON.stringify(growthReport.cases.filter(result => !result.passed)),
);
console.log(`Cloudflare progressive UsageStore conformance: PASS (${endpoint})`);

const vectorReport = await runVectorUsageStoreConformance({
  createStore() {
    return monitoredStore();
  },
  async waitForLeaseExpiry(ttlMs) {
    await sleep(ttlMs + 250);
  },
  leaseTtlMs: 500,
  concurrency: 8,
});
if (!vectorReport.passed) reportTransportFailures('vector');
assert.equal(
  vectorReport.passed,
  true,
  JSON.stringify(vectorReport.cases.filter(result => !result.passed)),
);
console.log(`Cloudflare vector UsageStore conformance: PASS (${endpoint})`);
