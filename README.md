# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**Failure-safe transactional usage enforcement around MCP tool execution.**

`mcp-usage-control` reserves usage capacity **before** metered work starts and settles actual usage afterward. It is designed for concurrency, retry, process loss, long-running work, and MCP multi-round flows where a naive `check -> execute -> increment` model can oversubscribe a real budget.

The project focuses on the boundary between execution and usage accounting. It is not a payment processor, financial ledger, subscription system, OAuth provider, generic gateway, workflow engine, or ordinary HTTP rate limiter.

> New here? Start with **[Getting started](docs/getting-started.md)**.

## Current distribution status

**The packages are not published to npm yet.**

Use a repository checkout or locally packed tarballs. Registry publication is a separate manual operation and remains explicitly deferred.

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

See **[Use from source / local tarballs](docs/using-from-source.md)** for clean-consumer installation.

Requirements: **Node.js 20+**, ESM. CI exercises Node.js 20/22/24, Redis 7, the MCP TypeScript SDK v2 path, Cloudflare local/workerd integration, Firestore Emulator integration, package tarballs, and clean-consumer imports.

## Core lifecycle

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                      ^                           |
                                      |---------- renew ----------|
```

A reservation begins `pending`. Immediately before work may incur metered cost, it becomes `cost-liable`.

- expired **pending** reservation: capacity can be released;
- expired **cost-liable** reservation: full reserved usage is retained conservatively when actual usage is unknown.

A process crash after execution may have started therefore cannot become an automatic refund.

## Why this is not a normal rate limiter

If one unit remains and two requests both perform:

```text
check remaining -> execute paid work -> increment counter
```

both can observe the same remaining unit and both begin work.

This project instead makes admission and reservation one authoritative store transition. For multi-budget policies, **all budgets reserve or none do**.

## Packages

| Package | Purpose |
| --- | --- |
| `mcp-usage-control` | Core policy/store contract, leases, settlement, observability, Memory reference store, Store conformance runner |
| `mcp-usage-control-mcp` | MCP TypeScript SDK v2 tool wrappers, multi-round accounting, flow-store conformance runner |
| `mcp-usage-control-redis` | Redis `UsageStore` plus shared Redis MCP flow store |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objects + SQLite store, local and authenticated remote paths |
| `mcp-usage-control-firestore` | Server-side Firestore transactional store |

All five package manifests are aligned at `0.6.0` for the next GitHub/source release preparation. `v0.5.0` remains the latest released source baseline; npm registry publication remains intentionally deferred.

## v1 scope under consideration after v0.5

The v1 API freeze is still not final. The v0.6 decision adopts failure-safe progressive reservation growth as an optional future-v1 capability while keeping the base fixed-reservation `UsageStore` contract compatible.

| Area | Current status | Boundary |
| --- | --- | --- |
| Core reserve / liability / renew / settle | **strong v1 candidate** | Failure-safe transaction contract |
| Multi-budget admission / replay protection | **strong v1 candidate** | Atomic and scoped by logical operation identity |
| Redis / Cloudflare / Firestore Stores | **strong v1 candidate with documented deployment constraints** | Provider durability/time/HA differences remain explicit |
| `protectTool()` | **strong v1 candidate** | Single-round MCP tools |
| `protectMultiRoundTool()` | **strong v1 candidate** | Supported `input_required` multi-round accounting |
| Shared/durable MRTR compare-and-consume | **current v1 direction** | Cross-instance resume without sticky MCP sessions |
| Progressive reservation growth (#83) | **adopted in v0.6** | Optional `UsageLease.grow()` / `ProgressiveUsageStore`; atomic/lost-ACK/provider proof |
| Heterogeneous multi-dimensional usage (#84) | **open v1-scope candidate** | v0.5 uses one scalar unit count; vector accounting needs atomic design proof |
| First-class MCP Tasks wire/runtime adapter | **scope depends on upstream stabilization** | Accounting semantics are defined; stable adapter is not yet claimed |
| New stateless MRTR claim mode | **deferred unless justified** | No demonstrated advantage over shared one-time claim |
| Billing / financial ledger / workflow replay | **out of scope** | Remains outside usage enforcement |

See **[v1.0 readiness review](docs/v1-readiness.md)** and **[Roadmap](docs/roadmap.md)** for the current scope decision process.

## Multi-budget admission

One invocation may consume the same quoted units from several budgets atomically:

```ts
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    const tenant = request.principal.tenantId ?? 'personal';
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-13`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenant}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

If one participating budget cannot admit the units, no participating budget is partially reserved.

## Logical-operation replay scope

Replay protection is scoped by:

```text
(tenantId, principal.id, tool, operationId)
```

Use the same stable `operationId` when retrying one logical invocation. `operationId` is an idempotency input, **not** authentication or authorization proof.

## Direct core example

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();

try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  // Settle zero only when you can prove that no metered cost was incurred.
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

Long-running direct-core work must renew the lease while authoritative execution remains active.

Successful admission also exposes authoritative `remainingByBudget`; do not recompute remaining capacity from configured limits in another layer.

Budget window and lifetime semantics are application-owned. The same `budget.key` names the same accounting bucket; changing the key creates a different bucket. Core and Store implementations do not infer daily/monthly reset boundaries or automatically reset a non-zero budget.

`MemoryUsageStore.stats()` reports retained accounting/replay state, not consumed quota. In particular, `retainedOperations` includes active reservations and settled replay tombstones and must not be interpreted as `consumedUnits`.

### Long-running Memory store use

`MemoryUsageStore` is process-local, but controlled single-process deployments can bound retained operation/tombstone and non-zero budget-key state. Capacity exhaustion fails closed rather than evicting authoritative accounting state. `stats()` exposes retention counters, and completed time-window budget keys can be removed explicitly with `retireBudgetKey()` once the application knows that accounting window is permanently over.

See [Memory store operations](docs/memory-store.md) before keeping the in-memory store alive for long periods. Horizontal or restart-durable deployments should use a shared provider-backed Store.

## MCP TypeScript SDK v2

### Single-round tools

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  { /* schema and metadata */ },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => ({ id: ctx.http.authInfo.subject }),
      operationId: (_args, ctx) => String(ctx.mcpReq.id),
    },
    async (args, ctx) => search(args, ctx),
  ),
);
```

`protectTool()` reserves before execution, marks liability immediately before handler entry, renews active leases by default, distinguishes normal success / MCP `{ isError: true }` / thrown exceptions, settles classifier failure conservatively, and does not blindly retry ambiguous settlement failures.

### Multi-round `input_required`

Use `protectMultiRoundTool()` for logical operations that continue across fresh MCP requests.

The wrapper:

- reserves once on the first round;
- stores the resumable lease server-side;
- requires integrity-verified request state;
- binds resume to trusted principal / optional tenant / tool / original args hash;
- atomically consumes a matching resume flow once;
- resumes the existing lease rather than reserving again;
- fails closed on replay, mismatch, expiry, corruption, or ambiguous consume failure.

`MemoryMcpUsageFlowStore` is for tests/single-process servers. Horizontal scale needs a shared/durable flow store such as `RedisMcpUsageFlowStore`.

**Sticky MCP sessions are not required for accounting.** Fresh requests may hit different server instances when `UsageStore` and flow state are shared where required.

Business side-effect idempotency/result replay remains application-owned. A consumed usage-flow token is not permission to blindly replay a destructive operation.

See [MCP integration](docs/mcp-integration.md) and [MCP protocol conformance](docs/mcp-conformance.md).

## MCP Tasks accounting

Long-running Tasks use a separate protocol/business state machine, but the accounting rules are already defined:

- one reservation per logical operation, independent of task ID;
- `working` does not automatically mean cost-liable;
- mark liability immediately before metered work;
- renew server-side while authoritative work remains active or intentionally waits for input;
- a `tasks/cancel` acknowledgement does **not** prove zero cost or authorize a refund;
- pre-liability cancellation may settle zero when proved;
- liable crash/unknown usage remains conservative;
- business task creation/result replay stays outside `UsageStore`.

The upstream Tasks TypeScript integration surface is still experimental, so this project does **not** currently claim a stable first-class Tasks adapter. See [MCP Tasks accounting](docs/mcp-tasks-accounting.md).

## Production Stores

### Redis

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
```

Redis uses Lua for atomic transitions and Redis server `TIME` for lease/tombstone decisions. Redis atomicity is **not** financial-ledger durability; configure persistence/HA to match your enforcement risk tolerance.

### Cloudflare Durable Objects

The Cloudflare adapter uses a Durable Object + SQLite transaction domain. Remote applications use an explicitly authenticated HTTPS gateway. Network/timeout ambiguity is surfaced, not blindly retried.

Real deployed dogfood has validated the main accounting path, while Issue #24 intentionally remains open for additional real-platform operational observations. Do not interpret the adapter as proven under every Cloudflare platform-limit condition.

The optional `mcp-usage-control-cloudflare/auth` helper supports a current and previous Bearer token to make controlled credential rotation possible without weakening the application-defined authorization boundary.

### Firestore

The Firestore adapter is server-side only and uses Firestore transactions for admission, settlement, and expiry recovery. Its supported recovery profile assumes bounded/synchronized host clocks with `expiryGraceMs` sized to cover maximum expected positive clock lead plus margin; strongly shared budget documents can become contention hotspots.

See [Redis](docs/redis.md), [Cloudflare](docs/cloudflare.md), and [Firestore](docs/firestore.md) before production deployment.

## Third-party Store compatibility

Implementing the `UsageStore` methods is not enough to call a Store safe.

Use the normative **[Store implementation contract](docs/store-contract.md)** and the reusable runners:

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

Portable conformance proves behavioral state-machine compatibility. Persistence, failover, authoritative time, and lost-ACK behavior still require backend-specific evidence.

## Observability

`UsageObserver` receives structured lifecycle events outside the enforcement transaction. Observer failure cannot turn denial/error into allow or alter settlement.

Tool arguments and raw exception messages are not captured automatically. Unique principal/operation/reservation/budget IDs should not be promoted to metric labels. `projectUsageEvent()` provides a low-cardinality projection for operational logging.

Observability is not a durable billing ledger.

See [Observability](docs/observability.md).

## Safety invariants

1. Admission comparison and reservation are one authoritative Store operation.
2. Every participating budget reserves atomically or none does.
3. Replay identity is `(tenantId, principal.id, tool, operationId)`.
4. Metered execution is preceded by `markLiable()`.
5. Pending expiry may release capacity; liable expiry conservatively retains the reservation.
6. Active long-running leases are renewable.
7. `actualUnits` cannot exceed `reservedUnits` in the current v0.5 model.
8. Identical settlement replay is idempotent during retention; conflicting settlement fails.
9. Storage failures do not become allow decisions.
10. Ambiguous state-changing outcomes are not blindly retried.
11. MCP multi-round resume is integrity-verified, binding-aware, and one-time.
12. Resume does not create a second usage reservation.
13. Client liveness/cancellation ACK alone never proves a refund is safe.
14. Observability cannot change enforcement state.
15. Business-operation replay is separate from usage accounting.

## Documentation

- [Getting started](docs/getting-started.md)
- [Use from source / local tarballs](docs/using-from-source.md)
- [MCP integration](docs/mcp-integration.md)
- [MCP protocol conformance](docs/mcp-conformance.md)
- [MCP Tasks accounting](docs/mcp-tasks-accounting.md)
- [Architecture](docs/architecture.md)
- [Memory store operations](docs/memory-store.md)
- [Store implementation contract](docs/store-contract.md)
- [Redis](docs/redis.md)
- [Cloudflare](docs/cloudflare.md)
- [Firestore](docs/firestore.md)
- [Observability](docs/observability.md)
- [API reference](docs/api-reference.md)
- [Project positioning](docs/positioning.md)
- [Roadmap](docs/roadmap.md)
- [v1.0 readiness review](docs/v1-readiness.md)
- [Release policy](docs/releasing.md)

Project policies: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Release boundary

`v0.6.0` is the current source-release preparation target. #83 is adopted for the future v1 surface; later ladder decisions remain intentionally open. Tag/Release creation and npm publication remain separate operations.

**npm publication remains a separate explicitly authorized operation and has not been performed.**

## License

Apache-2.0