# Durable MCP multi-round execution — executable provider matrix (v1.3.0 baseline)

[日本語](README.ja.md) | [English](README.md)

This is a **developer-only runner** that exercises the actual official MCP
TypeScript `2026-07-28` Streamable HTTP protocol across two or more request
rounds, using Redis, Firestore Emulator or local Cloudflare workerd as the
**authoritative backing store**, not a process-local fake. It executes the
same provider scripts that run in CI and does **not** impersonate production
application identity, authenticate users, or invoke paid APIs.

From the monorepo root, run `pnpm install --frozen-lockfile` and `pnpm build`. The durable FlowStore exports are part of the **v1.3.0** release line. Verify the separate [npm publication status](https://www.npmjs.com/package/mcp-usage-control) before installing from the registry; a GitHub source tag alone does not publish npm packages.

## Install v1.3.0 packages

On Node.js 22/24 with server-side ESM, after all five npm packages are available:

```sh
npm install mcp-usage-control@1.3.0 mcp-usage-control-mcp@1.3.0 \
  mcp-usage-control-redis@1.3.0 mcp-usage-control-firestore@1.3.0 \
  mcp-usage-control-cloudflare@1.3.0 \
  @modelcontextprotocol/server@^2.3.1 @modelcontextprotocol/client@^2.3.1
```

**Security maintenance:** This installation is the historical published **v1.3.0** provider matrix, not the latest security patch. It explicitly selects the patched SDK server peer `^2.3.1`, regardless of the v1.3.0 adapter's more permissive peer declaration. For fresh deployments, prefer **v1.3.1 after npm publication is separately confirmed**; configure `maxToolInputElements` and HTTP body bounds in the actual server. Do not assume that an upgraded SDK applies the limits automatically.

For an unpublished release candidate, use a local build or the exact validated tarball assets from GitHub Release. The application remains responsible for server identity, Firebase IAM, Durable Object bindings, secrets and SDK peer configuration. npm v1.2.0 does not contain these new FlowStore exports.

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

The v1.3.0 public ESM entry points are
`mcp-usage-control-redis/mcp-flow`,
`mcp-usage-control-firestore/mcp-flow`,
`mcp-usage-control-cloudflare/mcp-flow`, and
`mcp-usage-control-cloudflare/mcp-flow-worker`. Existing v1.2 installations do **not** include these v1.3 APIs.

Note: `--start-workerd` refuses to run if port `127.0.0.1:8799` is already occupied, rather than claiming isolation against another Worker.

### Exact candidate tarball consumer acceptance (CI)

Beyond the source-linked developer runner, provider CI now constructs clean
npm projects, installs the **exact version-matched candidate `.tgz` artifacts**
(all five in the Redis consumer, each provider's required packages in its
own CI), and executes official SDK HTTP multi-round E2E against real Redis
and Firestore Emulator. The Cloudflare job installs the candidate tarballs
in a separate npm project and runs a dedicated local workerd Worker imported
**exclusively through those installed packages**, including both packaged DO
classes. Source runs and new consumer tests have separate, explicit scopes.
These are candidate artifacts, **not evidence that npm v1.3 is already live**.
