# Durable MCP multi-round execution — executable provider matrix (v1.3 candidate)

[日本語](README.ja.md) | [English](README.md)

This is a **developer-only runner** that exercises the actual official MCP
TypeScript `2026-07-28` Streamable HTTP protocol across two or more request
rounds, using Redis, Firestore Emulator or local Cloudflare workerd as the
**authoritative backing store**, not a process-local fake. It executes the
same provider scripts that run in CI and does **not** impersonate production
application identity, authenticate users, or invoke paid APIs.

From the monorepo root, first run `pnpm install --frozen-lockfile` and
`pnpm build`. The current npm-distributed packages are **v1.2.0**;
these v1.3 FlowStore exports and tests exist on `main` **only until the
v1.3 release is separately approved**.

## Run a real provider

**Redis** — start a disposable local Redis 7 server, then:

```sh
REDIS_URL=redis://127.0.0.1:6379 node examples/mcp-durable-multi-round/run.mjs redis
```

The test uses Redis database 13 with a unique random key prefix. The
`mcp-usage-control-redis/mcp-flow` API uses Redis-side `TIME` and atomic Lua
`compare-and-consume`. Never point this at live customer Redis data.

**Firestore** — start a Firestore Emulator only, with project
`demo-muc-firestore`, for example:

```sh
firebase emulators:start --only firestore --project demo-muc-firestore
```

In another terminal:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-muc-firestore \
  node examples/mcp-durable-multi-round/run.mjs firestore
```

The test refuses to run without `FIRESTORE_EMULATOR_HOST`; it uses distinct
randomly named server-only account/flow collections. Firestore transaction
snapshot `readTime`, a conservative expiry safety margin and asynchronous TTL
storage cleanup are **not** a Redis-equivalent distributed clock.

**Cloudflare** — no Cloudflare account or remote deployment is needed.
The runner starts local workerd with isolated temporary Durable Object storage:

```sh
node examples/mcp-durable-multi-round/run.mjs cloudflare --start-workerd
```

Alternatively, manually start the local test Worker at port 8799 using
`packages/cloudflare/wrangler.test.jsonc` then run `... run.mjs cloudflare`.
The test Worker requires **localhost, an explicit testing flag, and a
local-test-only bearer token**. The accounting and MCP flow DO namespaces and
SQLite schemas are separate. This test is direct same-Worker DO RPC, not a
production remote HTTP FlowStore endpoint. DO-side clock and per-flow alarms
have cost/retention implications; they do not promise cross-DO transactions.

`run.mjs all --start-workerd` runs all three sequentially, but Redis and the
Firestore Emulator must already be running. A missing required backend fails
closed rather than silently falling back to Memory.

## What the official SDK tests demonstrate

A first `tools/call` reserves one stable logical operation; the protected
handler returns `input_required`. A **second real HTTP tool request** hits a
fresh MCP server factory, verifies an integrity-protected SDK requestState,
recovers the original **one-time claimed** server-side flow/lease, resumes the
original `operationId`, and settles without a new reservation. A replay after
completion is denied. Workerd/Redis/Firestore-specific conformance tests also
exercise atomic 16-way consume contention, principal/tenant/args binding,
expiry and lost acknowledgements. The three scripts are intentionally kept
small; see Issue #271 for the remaining full cross-provider failure-injection
matrix.

A consumed flow is **not** permission to replay non-idempotent work: every
application must fence provider effects, maintain its own business results and
observe the original lease. Signed requestState is *not* proof of authentication:
principal/tenant/operation identity must be established by the application
server, never trusted from client-supplied arguments. Unknown cost after a
liable operation is settled conservatively; never infer a zero-cost refund from
client disconnects or failed transport acknowledgements.

## Provider selection and operator safeguards

| Provider | Durability and atomicity domain | Clock / cleanup | Limits |
| --- | --- | --- | --- |
| Redis | Per-flow Lua script, one Redis hash slot | Redis TIME + PXAT | External Redis HA and persistence configuration required |
| Firestore | One-document transaction in one database | Transaction snapshot readTime + separately configured async TTL (`deleteAt`) | IAM/server-only collection, transaction latency/uncertain ACK |
| Cloudflare DO | One isolated SQLite DO per flow ID | DO-host Date.now + DO alarm, default 24h retention | Same-Worker RPC only, per-flow cost, no cross-DO HA promise |

Before production, configure platform-specific permissions, clock bounds,
quotas, retention, cleanup, idempotent result handling, app-owned authorization,
secret rotation and incident procedures. `input_required` and signed state must
never be forwarded in raw logs or client-visible backend exception text.

The new public ESM entry points **after an authorized release** are
`mcp-usage-control-redis/mcp-flow`,
`mcp-usage-control-firestore/mcp-flow`,
`mcp-usage-control-cloudflare/mcp-flow`, and
`mcp-usage-control-cloudflare/mcp-flow-worker`. Existing published v1.2
installations are **not** claimed to already include these v1.3 APIs.
