# Provider benchmark and cost-profile harness

[English](provider-benchmarks.md) | [日本語](provider-benchmarks.ja.md)

`mcp-usage-control` correctness/conformance tests answer **whether a Store preserves accounting invariants**. The benchmark harness answers a different question: **what latency/contention shape does the same contract have in this specific environment?** A faster result never relaxes atomic admission, liability, replay, expiry, or settlement semantics.

## Run the harness

Build first, then choose one provider:

```console
pnpm build
MUC_BENCH_ITERATIONS=100 MUC_BENCH_CONCURRENCY=8 pnpm benchmark:memory
REDIS_URL=redis://127.0.0.1:6379 pnpm benchmark:redis
```

Firestore intentionally refuses production and requires the Local Emulator Suite:

```console
GCLOUD_PROJECT=demo-muc-firestore-benchmark \
  pnpm dlx firebase-tools@15.24.0 emulators:exec \
  --only firestore \
  --project demo-muc-firestore-benchmark \
  "MUC_BENCH_ITERATIONS=50 node scripts/benchmark-usage-store.mjs firestore"
```

For Cloudflare, start the repository's local workerd configuration and benchmark its localhost gateway:

```console
MCP_USAGE_CLOUDFLARE_TOKEN=local-integration-token \
  pnpm dlx wrangler@4.114.0 dev --local \
  --config packages/cloudflare/wrangler.test.jsonc \
  --port 8799

MCP_USAGE_CLOUDFLARE_TOKEN=local-integration-token \
  MUC_BENCH_ITERATIONS=100 \
  pnpm benchmark:cloudflare
```

Output is JSON and includes timestamp, Node/platform, provider target, iteration/concurrency settings, success/error counts, and p50/p95/p99/min/max latency.

## Covered workloads

The version-1 harness measures:

- scalar reserve allow and quota denial;
- three-budget atomic reserve;
- `markLiable`, `renew`, and settlement;
- progressive reservation growth;
- vector reserve/grow/settle;
- active scalar reconciliation where the provider exposes it;
- concurrent admission against one shared hot budget, while asserting the exact expected accepted/denied count;
- bounded explicit recovery where the adapter exposes such an operation (currently Firestore).

Preparation work is outside the timed section for lifecycle operations such as settlement, so the measured sample is the named Store transition rather than its setup reserve.

## Safety boundary for deployed measurements

The harness is safe-by-default:

- Firestore requires `FIRESTORE_EMULATOR_HOST` and cannot target production Firestore.
- Redis and Cloudflare targets outside localhost require `MUC_BENCH_ALLOW_REMOTE=1`.
- Remote Cloudflare still follows the adapter's normal HTTPS rule; the benchmark does not weaken it.
- Every run uses a fresh random benchmark namespace/domain identity.
- Never point a benchmark at a shared production accounting domain or intentionally burn a real user's/shared quota.

For a deployed test, provision an explicit disposable benchmark environment, set `MUC_BENCH_ALLOW_REMOTE=1`, record region/runtime/provider configuration, and delete/retire that test domain according to the provider's lifecycle rules afterwards.

## How to read provider cost/amplification

These are operation shapes, not universal prices. Provider billing changes independently; use the provider's current pricing with the measured workload.

| Store | Rough authoritative operation shape |
| --- | --- |
| Memory | process-local map/state transitions; reference semantics only |
| Redis | one server-side Lua/EVAL transition per Store lifecycle method; all participating budgets share the configured Redis Cluster hash slot |
| Firestore | reserve reads reservation + `N` budget documents and, on success, writes reservation + `N` budgets; `markLiable`/`renew` touch the reservation; settlement/recovery transactionally touch required reservation/budget documents |
| Cloudflare remote DO | one authenticated HTTP request per remote Store operation into one Durable Object accounting domain; SQLite statements are internal implementation detail and may change without changing the public contract |

A three-budget Firestore admission therefore has more transaction participants and billable database operations than a one-budget admission. A shared/hot budget also creates a common Firestore transaction participant, so contention/retry latency can dominate raw no-contention latency. Redis and Durable Objects centralize the same atomicity differently; measure the deployment topology you actually intend to use.

## Initial local baselines

Versioned raw results are stored under [`docs/benchmarks/`](benchmarks/). The first 2026-08-29 records are **smoke baselines, not SLOs or provider rankings**:

All four initial baselines use Node.js 22.23.2 in a Linux arm64 container on the development Mac. Memory is process-local, Redis reaches a local Redis 7 container, Firestore reaches the Local Emulator Suite, and Cloudflare runs local workerd inside the same isolated Node 22 environment.

The Firestore smoke run visibly demonstrates why shared-budget contention must be measured separately: the hot-budget scenario was orders of magnitude slower than its uncontended operations in that emulator environment. Do not transplant those numbers into production estimates; rerun with production-like region/concurrency/topology in a disposable test environment.

## Regression policy

Performance results are intentionally **non-blocking CI evidence**. Correctness/conformance remains blocking. Re-run the benchmark when a release materially changes Store scripts/transactions, cleanup, serialization, transport, or contention behavior. Investigate a repeatable material regression under the same pinned environment, but do not fail normal PR CI on noisy wall-clock thresholds.
