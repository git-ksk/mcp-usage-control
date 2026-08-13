import assert from 'node:assert/strict';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from '../dist/index.js';

const endpoint =
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
const endpointUrl = new URL(endpoint);
const isLocalWorkerd =
  endpointUrl.protocol === 'http:' &&
  (endpointUrl.hostname === '127.0.0.1' || endpointUrl.hostname === 'localhost');
const currentToken = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
const previousToken =
  process.env.MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN ??
  (isLocalWorkerd ? 'local-integration-previous-token' : undefined);
const retiredToken =
  process.env.MCP_USAGE_CLOUDFLARE_RETIRED_TOKEN ??
  (isLocalWorkerd ? 'rotated-out-local-token' : undefined);
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function storeFor(token) {
  return new RemoteCloudflareUsageStore({
    endpoint,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function authenticatedProbe(token, label) {
  const store = storeFor(token);
  const result = await store.reserve({
    request: {
      operationId: `${nonce}-${label}`,
      principal: { id: `rotation-${label}`, tenantId: 'rotation-test', plan: 'free' },
      tool: 'rotation-probe',
      args: {},
    },
    units: 1,
    budgets: [{ key: `${nonce}:${label}`, limit: 1 }],
    ttlMs: 2_000,
  });
  assert.equal(result.accepted, true, `${label} credential must be accepted`);
  if (result.accepted) {
    await store.settle({
      reservationId: result.reservation.id,
      actualUnits: 0,
      outcome: 'rotation_probe',
    });
  }
}

await authenticatedProbe(currentToken, 'current');

if (previousToken) {
  await authenticatedProbe(previousToken, 'previous');
}

if (retiredToken) {
  await assert.rejects(
    () => authenticatedProbe(retiredToken, 'retired'),
    error => error instanceof CloudflareUsageTransportError && error.code === 'unauthorized',
    'retired credential must be rejected',
  );
}

console.log(
  `Cloudflare credential rotation: PASS (${previousToken ? 'overlap checked, ' : ''}${retiredToken ? 'retirement checked' : 'current checked'})`,
);
