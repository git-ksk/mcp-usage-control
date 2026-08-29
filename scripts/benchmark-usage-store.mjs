#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { MemoryUsageStore } from '../packages/core/dist/index.js';

const provider = process.argv[2] ?? 'memory';
const iterations = positiveInt(process.env.MUC_BENCH_ITERATIONS, 40);
const concurrency = positiveInt(process.env.MUC_BENCH_CONCURRENCY, 8);
const ttlMs = positiveInt(process.env.MUC_BENCH_TTL_MS, 60_000);
const runId = process.env.MUC_BENCH_RUN_ID ?? randomUUID().replaceAll('-', '').slice(0, 16);

const adapter = await createAdapter(provider, runId);
const scenarios = [];

try {
  scenarios.push(await measureSequential('scalar.reserve.allow', iterations, async index => {
    const result = await adapter.store.reserve({
      request: request(`reserve-${index}`),
      units: 1,
      budgets: [{ key: budget(`allow-${index}`), limit: 10 }],
      ttlMs,
    });
    assertAccepted(result, 'scalar reserve allow');
  }));

  scenarios.push(await measureSequential('scalar.reserve.deny', iterations, async index => {
    const result = await adapter.store.reserve({
      request: request(`deny-${index}`),
      units: 1,
      budgets: [{ key: budget(`deny-${index}`), limit: 0 }],
      ttlMs,
    });
    if (result.accepted || result.reason !== 'quota_exceeded') {
      throw new Error('expected quota_exceeded');
    }
  }));

  scenarios.push(await measureSequential('scalar.reserve.multi_budget', iterations, async index => {
    const result = await adapter.store.reserve({
      request: request(`multi-${index}`),
      units: 1,
      budgets: [
        { key: budget(`multi-user-${index}`), limit: 10 },
        { key: budget(`multi-tenant-${index}`), limit: 10 },
        { key: budget(`multi-product-${index}`), limit: 10 },
      ],
      ttlMs,
    });
    assertAccepted(result, 'multi-budget reserve');
  }));

  scenarios.push(await measurePrepared('scalar.mark_liable', iterations, async index => {
    const admission = await reserveScalar(adapter.store, `liable-${index}`);
    return () => adapter.store.markLiable({ reservationId: admission.reservation.id });
  }));

  scenarios.push(await measurePrepared('scalar.renew', iterations, async index => {
    const admission = await reserveScalar(adapter.store, `renew-${index}`);
    return () => adapter.store.renew({ reservationId: admission.reservation.id, ttlMs });
  }));

  scenarios.push(await measurePrepared('scalar.settle', iterations, async index => {
    const admission = await reserveScalar(adapter.store, `settle-${index}`);
    await adapter.store.markLiable({ reservationId: admission.reservation.id });
    return () => adapter.store.settle({
      reservationId: admission.reservation.id,
      actualUnits: 1,
      outcome: 'completed',
    });
  }));

  if (typeof adapter.store.growReservation === 'function') {
    scenarios.push(await measurePrepared('progressive.grow', iterations, async index => {
      const admission = await reserveScalar(adapter.store, `grow-${index}`, 1, 10);
      if (!admission.reservation.growthCursor) throw new Error('growth cursor missing');
      return () => adapter.store.growReservation({
        reservationId: admission.reservation.id,
        incrementId: `inc-${index}`,
        expectedGrowthCursor: admission.reservation.growthCursor,
        additionalUnits: 1,
        budgets: [{ key: budget(`scalar-grow-${index}`), limit: 10 }],
      });
    }));
  } else {
    scenarios.push(unsupported('progressive.grow'));
  }

  if (typeof adapter.store.reserveVector === 'function') {
    scenarios.push(await measureSequential('vector.reserve', iterations, async index => {
      const result = await adapter.store.reserveVector({
        request: request(`vector-reserve-${index}`),
        dimensions: vectorDimensions(index),
        ttlMs,
      });
      assertAccepted(result, 'vector reserve');
    }));

    scenarios.push(await measurePrepared('vector.grow', iterations, async index => {
      const admission = await adapter.store.reserveVector({
        request: request(`vector-grow-${index}`),
        dimensions: vectorDimensions(index),
        ttlMs,
      });
      assertAccepted(admission, 'vector growth setup');
      if (!admission.reservation.growthCursor) throw new Error('vector growth cursor missing');
      return () => adapter.store.growVectorReservation({
        reservationId: admission.reservation.id,
        incrementId: `vector-inc-${index}`,
        expectedGrowthCursor: admission.reservation.growthCursor,
        dimensions: [
          {
            key: 'requests',
            additionalUnits: 1,
            budgets: [{ key: budget(`vector-requests-${index}`), limit: 20 }],
          },
          {
            key: 'provider_cost',
            additionalUnits: 1,
            budgets: [{ key: budget(`vector-cost-${index}`), limit: 40 }],
          },
        ],
      });
    }));

    scenarios.push(await measurePrepared('vector.settle', iterations, async index => {
      const admission = await adapter.store.reserveVector({
        request: request(`vector-settle-${index}`),
        dimensions: vectorDimensions(index),
        ttlMs,
      });
      assertAccepted(admission, 'vector settlement setup');
      await adapter.store.markLiable({ reservationId: admission.reservation.id });
      return () => adapter.store.settleVector({
        reservationId: admission.reservation.id,
        actualByDimension: [
          { key: 'requests', actualUnits: 1 },
          { key: 'provider_cost', actualUnits: 2 },
        ],
        outcome: 'completed',
      });
    }));
  } else {
    scenarios.push(unsupported('vector.reserve'), unsupported('vector.grow'), unsupported('vector.settle'));
  }

  if (adapter.reconcile) {
    scenarios.push(await measurePrepared('reconciliation.active_lookup', iterations, async index => {
      const operationId = `reconcile-${index}`;
      const budgets = [{ key: budget(`reconcile-${index}`), limit: 10 }];
      await reserveScalar(adapter.store, operationId, 1, 10, budgets);
      return () => adapter.reconcile({ request: request(operationId), units: 1, budgets });
    }));
  } else {
    scenarios.push(unsupported('reconciliation.active_lookup'));
  }

  scenarios.push(await measureHotContention(adapter.store, iterations, concurrency));

  if (adapter.recovery) {
    scenarios.push(await adapter.recovery({ iterations: Math.min(iterations, 10), ttlMs: 25 }));
  } else {
    scenarios.push(unsupported('recovery.bounded'));
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider,
    runId,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      iterations,
      concurrency,
      ttlMs,
      ...adapter.metadata,
    },
    warning: 'Local/emulator measurements are environment-specific evidence, not universal SLOs.',
    scenarios,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await adapter.close?.();
}

function request(operationId) {
  return {
    operationId: `${runId}:${operationId}`,
    principal: { id: `bench-${runId}`, tenantId: 'bench-tenant', plan: 'bench' },
    tool: 'bench',
    args: {},
  };
}

function budget(suffix) {
  return `bench:${runId}:${suffix}`;
}

function vectorDimensions(index) {
  return [
    {
      key: 'requests',
      units: 1,
      budgets: [{ key: budget(`vector-requests-${index}`), limit: 20 }],
    },
    {
      key: 'provider_cost',
      units: 2,
      budgets: [{ key: budget(`vector-cost-${index}`), limit: 40 }],
    },
  ];
}

async function reserveScalar(store, suffix, units = 1, limit = 10, budgets) {
  const effectiveBudgets = budgets ?? [{ key: budget(`scalar-${suffix}`), limit }];
  const result = await store.reserve({ request: request(suffix), units, budgets: effectiveBudgets, ttlMs });
  assertAccepted(result, 'scalar setup reserve');
  return result;
}

async function measureSequential(name, count, operation) {
  const durations = [];
  let errors = 0;
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    try {
      await operation(index);
    } catch (error) {
      errors += 1;
      if (errors === 1) console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      durations.push(performance.now() - started);
    }
  }
  return summarize(name, durations, count - errors, errors);
}

async function measurePrepared(name, count, prepare) {
  const durations = [];
  let errors = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      const operation = await prepare(index);
      const started = performance.now();
      await operation();
      durations.push(performance.now() - started);
    } catch (error) {
      errors += 1;
      if (errors === 1) console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summarize(name, durations, count - errors, errors);
}

async function measureHotContention(store, batches, width) {
  const durations = [];
  let accepted = 0;
  let denied = 0;
  let errors = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const key = budget(`hot-${batch}`);
    const limit = Math.max(1, Math.floor(width / 2));
    const results = await Promise.all(Array.from({ length: width }, async (_, contender) => {
      const started = performance.now();
      try {
        const result = await store.reserve({
          request: request(`hot-${batch}-${contender}`),
          units: 1,
          budgets: [{ key, limit }],
          ttlMs,
        });
        return { duration: performance.now() - started, accepted: result.accepted };
      } catch {
        return { duration: performance.now() - started, error: true };
      }
    }));
    for (const result of results) {
      durations.push(result.duration);
      if (result.error) errors += 1;
      else if (result.accepted) accepted += 1;
      else denied += 1;
    }
  }
  const expectedAccepted = batches * Math.max(1, Math.floor(width / 2));
  const expectedDenied = batches * (width - Math.max(1, Math.floor(width / 2)));
  if (errors !== 0 || accepted !== expectedAccepted || denied !== expectedDenied) {
    throw new Error(
      `hot-budget invariant failed: accepted=${accepted}/${expectedAccepted} denied=${denied}/${expectedDenied} errors=${errors}`,
    );
  }
  return {
    ...summarize('contention.shared_hot_budget', durations, accepted + denied, errors),
    accepted,
    denied,
    batchConcurrency: width,
  };
}

function summarize(name, durations, ok, errors) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    name,
    supported: true,
    samples: durations.length,
    ok,
    errors,
    milliseconds: {
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      min: sorted.length ? round(sorted[0]) : null,
      max: sorted.length ? round(sorted.at(-1)) : null,
    },
  };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function unsupported(name) {
  return { name, supported: false, reason: 'provider surface does not expose this benchmark operation' };
}

function assertAccepted(result, context) {
  if (!result?.accepted) throw new Error(`${context} was not accepted`);
}

function positiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`invalid positive integer: ${value}`);
  return parsed;
}

function allowRemote(label, url) {
  const host = new URL(url).hostname;
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!local && process.env.MUC_BENCH_ALLOW_REMOTE !== '1') {
    throw new Error(`${label} benchmark target is remote; set MUC_BENCH_ALLOW_REMOTE=1 only for an explicit disposable test environment`);
  }
}

async function createAdapter(name, id) {
  if (name === 'memory') {
    const store = new MemoryUsageStore();
    return {
      store,
      reconcile: typeof store.reconcileOperation === 'function' ? input => store.reconcileOperation(input) : undefined,
      metadata: { target: 'process-local reference store' },
    };
  }

  if (name === 'redis') {
    const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    allowRemote('Redis', redisUrl);
    const { createClient } = await import('../packages/redis/node_modules/redis/dist/index.js');
    const { RedisUsageStore } = await import('../packages/redis/dist/index.js');
    const client = createClient({ url: redisUrl });
    await client.connect();
    const store = new RedisUsageStore(client, {
      prefix: `mucbench-${id}`,
      hashTag: `bench-${id}`,
      cleanupBatchSize: 16,
      idempotencyTtlMs: 60_000,
    });
    return {
      store,
      reconcile: input => store.reconcileOperation(input),
      close: () => client.quit(),
      metadata: { target: redactUrl(redisUrl), redis: 'node-redis 6.2.x' },
    };
  }

  if (name === 'firestore') {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('Firestore benchmark requires FIRESTORE_EMULATOR_HOST and refuses production Firestore');
    }
    const { Firestore } = await import('../packages/firestore/node_modules/@google-cloud/firestore/build/src/index.js');
    const { FirestoreUsageStore } = await import('../packages/firestore/dist/index.js');
    const projectId = process.env.GCLOUD_PROJECT ?? 'demo-muc-firestore-benchmark';
    const database = new Firestore({ projectId });
    const store = new FirestoreUsageStore(database, {
      collectionPrefix: `muc_bench_${id}`,
      cleanupBatchSize: 0,
      cleanupIntervalMs: 0,
      expiryGraceMs: 0,
      idempotencyTtlMs: 60_000,
    });
    return {
      store,
      reconcile: input => store.reconcileOperation(input),
      recovery: async ({ iterations: recoveryIterations, ttlMs: recoveryTtlMs }) => {
        for (let index = 0; index < recoveryIterations; index += 1) {
          const result = await store.reserve({
            request: request(`recovery-${index}`),
            units: 1,
            budgets: [{ key: budget(`recovery-${index}`), limit: 10 }],
            ttlMs: recoveryTtlMs,
          });
          assertAccepted(result, 'recovery setup');
        }
        await new Promise(resolve => setTimeout(resolve, recoveryTtlMs + 30));
        const started = performance.now();
        await store.recoverExpired(recoveryIterations);
        return summarize('recovery.bounded', [performance.now() - started], 1, 0);
      },
      close: () => database.terminate(),
      metadata: { target: `firestore-emulator://${process.env.FIRESTORE_EMULATOR_HOST}`, projectId },
    };
  }

  if (name === 'cloudflare') {
    const endpoint = process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
    allowRemote('Cloudflare', endpoint);
    const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
    const headers = { authorization: `Bearer ${token}` };
    const { RemoteCloudflareUsageStore } = await import('../packages/cloudflare/dist/index.js');
    const { reconcileRemoteCloudflareOperation } = await import('../packages/cloudflare/dist/reconciliation.js');
    const options = { endpoint, headers };
    const store = new RemoteCloudflareUsageStore(options);
    return {
      store,
      reconcile: input => reconcileRemoteCloudflareOperation(options, input),
      metadata: { target: redactUrl(endpoint), transport: 'remote Durable Object gateway' },
    };
  }

  throw new Error(`unknown provider ${JSON.stringify(name)}; expected memory, redis, firestore, or cloudflare`);
}

function redactUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  return url.toString();
}
