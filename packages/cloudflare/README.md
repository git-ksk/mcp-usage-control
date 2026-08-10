# mcp-usage-control-cloudflare

Cloudflare Durable Objects + SQLite adapter for `mcp-usage-control`.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or a locally packed `mcp-usage-control-cloudflare-0.1.0.tgz`. See [Use from source / local tarballs](../../docs/using-from-source.md) / [日本語](../../docs/using-from-source.ja.md).

## English

The adapter provides two deployment paths:

- `CloudflareUsageStore` for a Worker that can call a Durable Object namespace directly.
- `RemoteCloudflareUsageStore` plus `createCloudflareUsageStoreGateway()` for applications outside Cloudflare, such as a GCP-hosted MCP server.

The Durable Object implementation is exported from `mcp-usage-control-cloudflare/worker` as `UsageControlDurableObject` and uses SQLite transactions for atomic multi-budget reserve, pending -> liable transitions, lease renewal, settlement, replay protection, and expiry recovery.

One configured Durable Object name is one atomic usage-control transaction domain. All budgets participating in one reservation are evaluated and updated in that same object.

### Privacy boundary

Before data crosses the Durable Object / HTTP boundary, the adapter SHA-256 hashes the logical operation tuple and every budget key. Settlement outcomes are also hashed. Raw principal IDs, tenant IDs, tool names, operation IDs, budget keys, and tool arguments are not sent to or persisted by the Cloudflare backend solely for usage enforcement.

Hashing is not encryption. Do not put secrets in identifiers.

### Remote gateway safety

The HTTP gateway has no allow-all authentication mode: callers must provide an application-defined `authorize(request)` callback. The remote client does not blindly retry timeouts or lost acknowledgements.

For applications that need to recover an ambiguous `reserve()` after a timeout/network failure, the optional `mcp-usage-control-cloudflare/reconciliation` subpath provides an authenticated read-only lookup. Use `createReconciliableCloudflareUsageStoreGateway()` and `reconcileRemoteCloudflareReserve()` explicitly; do not hide ambiguous reserve results behind generic retry middleware.

### Cost behavior

The adapter does not schedule alarms or intentionally keep a Durable Object active. Expiry/tombstone cleanup is lazy and bounded on subsequent operations. This minimizes background activity but means a large stale-state backlog can conservatively delay capacity recovery.

- [Cloudflare adapter guide](../../docs/cloudflare.md)
- [Reserve ACK reconciliation](../../docs/cloudflare-reserve-reconciliation.md)
- [SQLite schema migrations](../../docs/cloudflare-schema-migrations.md)
- [Observability](../../docs/observability.md)
- [Architecture](../../docs/architecture.md)
- [Security](../../SECURITY.md)

## 日本語

このadapterは2つの利用形態を提供します。

- Cloudflare Worker内からDurable Object bindingを直接利用する `CloudflareUsageStore`。
- GCP上のMCP server等、Cloudflare外から利用する `RemoteCloudflareUsageStore` + `createCloudflareUsageStoreGateway()`。

Durable Object実装は `mcp-usage-control-cloudflare/worker` の `UsageControlDurableObject` としてexportし、SQLite transactionでatomic multi-budget reserve、pending -> liable、lease renewal、settlement、replay protection、expiry recoveryを処理します。

1つのconfigured Durable Object nameが1つのatomic usage-control transaction domainです。1 reservationに参加する全budgetを同じobject内で評価・更新します。

### Privacy boundary

Durable Object / HTTP boundaryを越える前に、logical operation tupleと全budget keyをSHA-256 hash化します。settlement outcomeもhash化します。raw principal ID、tenant ID、tool名、operation ID、budget key、tool argumentsをusage enforcementのためだけにCloudflare backendへ送信・保存しません。

hashingはencryptionではありません。identifierへsecretを入れないでください。

### Remote gateway safety

HTTP gatewayにallow-all authentication defaultはありません。application側で `authorize(request)` callbackを必ず指定します。remote clientはtimeout / lost ACKをblind retryしません。

`reserve()` のtimeout / network failure後にambiguous resultを復元する必要があるapplication向けに、optionalな `mcp-usage-control-cloudflare/reconciliation` subpathがauthenticated read-only lookupを提供します。`createReconciliableCloudflareUsageStoreGateway()` と `reconcileRemoteCloudflareReserve()` を明示的に利用し、ambiguous reserveをgeneric retry middlewareで隠さないでください。

### Cost behavior

adapterはalarmをscheduleせず、Durable Objectを意図的に常駐させません。expiry / tombstone cleanupは後続operation時のlazy / bounded cleanupです。background activityを抑える代わりに、大量のstale stateがある場合はcapacity recoveryが保守的に遅れる可能性があります。

- [Cloudflare adapter guide](../../docs/cloudflare.ja.md)
- [Reserve ACK reconciliation](../../docs/cloudflare-reserve-reconciliation.ja.md)
- [SQLite schema migration](../../docs/cloudflare-schema-migrations.ja.md)
- [Observability](../../docs/observability.ja.md)
- [Architecture](../../docs/architecture.ja.md)
- [Security](../../SECURITY.ja.md)
