# mcp-usage-control-cloudflare

Cloudflare Durable Objects + SQLite adapter for `mcp-usage-control`.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or a locally packed `mcp-usage-control-cloudflare-<version>.tgz`. See [Use from source / local tarballs](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md) / [日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md).

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

For simple Bearer-token deployments, `mcp-usage-control-cloudflare/auth` exports `createCloudflareBearerTokenAuthorizer()`. It accepts a required current token plus one optional previous token so callers can rotate credentials without an authentication gap:

```ts
import { createCloudflareBearerTokenAuthorizer } from 'mcp-usage-control-cloudflare/auth';

const authorize = createCloudflareBearerTokenAuthorizer({
  currentToken: env.MCP_USAGE_TOKEN,
  previousToken: env.MCP_USAGE_PREVIOUS_TOKEN,
});
```

For zero-downtime rotation, first copy the current token into the previous-token slot, then replace the current token, move callers to the new token, and finally remove the previous token. Keep the overlap short. Applications with stronger identity requirements can continue supplying their own `authorize(request)` implementation; the helper is optional and does not change the gateway contract.

For applications that need to recover an ambiguous `reserve()` after a timeout/network failure, the optional `mcp-usage-control-cloudflare/reconciliation` subpath provides an authenticated read-only lookup. Use `createReconciliableCloudflareUsageStoreGateway()` and the v0.8 `reconcileRemoteCloudflareOperation()` entry point explicitly; `reconcileRemoteCloudflareReserve()` remains as a v0.7-compatible alias. Do not hide ambiguous reserve results behind generic retry middleware.

Historical window cleanup is also explicit. The optional `mcp-usage-control-cloudflare/maintenance` subpath exposes a separate authenticated endpoint that prunes only application-selected historical budget keys in bounded batches. Protected/current keys and budgets referenced by active reservations are not deleted.

### Cost behavior

The adapter does not schedule alarms or intentionally keep a Durable Object active. Expiry/tombstone cleanup is lazy and bounded on subsequent operations. This minimizes background activity but means a large stale-state backlog can conservatively delay capacity recovery.

- [Cloudflare adapter guide](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare.md)
- [Deployed E2E / credential rotation](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-deployed-e2e.md)
- [Reserve ACK reconciliation](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-reserve-reconciliation.md)
- [Historical budget pruning](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-budget-pruning.md)
- [SQLite schema migrations](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-schema-migrations.md)
- [Observability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/observability.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.md)
- [Security](https://github.com/git-ksk/mcp-usage-control/blob/main/SECURITY.md)

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

単純なBearer token構成向けに、`mcp-usage-control-cloudflare/auth` は `createCloudflareBearerTokenAuthorizer()` を提供します。必須のcurrent tokenとoptionalなprevious tokenを同時に受け付けられるため、認証断を作らずcredential rotationできます。

```ts
import { createCloudflareBearerTokenAuthorizer } from 'mcp-usage-control-cloudflare/auth';

const authorize = createCloudflareBearerTokenAuthorizer({
  currentToken: env.MCP_USAGE_TOKEN,
  previousToken: env.MCP_USAGE_PREVIOUS_TOKEN,
});
```

無停止rotationでは、まず現在tokenをprevious slotへコピーし、その後current tokenを新tokenへ置換し、callerを新tokenへ切り替え、最後にprevious tokenを削除します。overlap期間は短く保ってください。より強いidentity要件があるapplicationは従来どおり独自の `authorize(request)` を利用でき、このhelperはoptionalでgateway contractを変更しません。

`reserve()` のtimeout / network failure後にambiguous resultを復元する必要があるapplication向けに、optionalな `mcp-usage-control-cloudflare/reconciliation` subpathがauthenticated read-only lookupを提供します。`createReconciliableCloudflareUsageStoreGateway()` とv0.8の `reconcileRemoteCloudflareOperation()` を明示的に利用してください。`reconcileRemoteCloudflareReserve()` はv0.7互換aliasとして維持します。ambiguous reserveをgeneric retry middlewareで隠さないでください。

historical window cleanupも明示操作です。optionalな `mcp-usage-control-cloudflare/maintenance` subpathは、applicationがhistoricalとして選択したbudget keyだけをbounded batchでpruneする別authenticated endpointを提供します。protected/current keyとactive reservationが参照中のbudgetは削除しません。

### Cost behavior

adapterはalarmをscheduleせず、Durable Objectを意図的に常駐させません。expiry / tombstone cleanupは後続operation時のlazy / bounded cleanupです。background activityを抑える代わりに、大量のstale stateがある場合はcapacity recoveryが保守的に遅れる可能性があります。

- [Cloudflare adapter guide](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare.ja.md)
- [実環境E2E / credential rotation](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-deployed-e2e.ja.md)
- [Reserve ACK reconciliation](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-reserve-reconciliation.ja.md)
- [Historical budget pruning](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-budget-pruning.ja.md)
- [SQLite schema migration](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/cloudflare-schema-migrations.ja.md)
- [Observability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/observability.ja.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.ja.md)
- [Security](https://github.com/git-ksk/mcp-usage-control/blob/main/SECURITY.ja.md)

## Operation reconciliation (v0.8)

The reconciliation subpath now uses the core `UsageOperationReconciliation` vocabulary. Cloudflare keeps the provider-specific authenticated lookup boundary instead of making reconciliation mandatory on the base remote Store API.

## Atomic vector usage (v0.7)

`CloudflareUsageStore` and `RemoteCloudflareUsageStore` implement optional `VectorUsageStore`. Schema v3 adds the `reservation_vectors` sidecar without rewriting v1/v2 scalar accounting rows. Durable Object `transactionSync` keeps all vector dimensions atomic; workerd integration covers vector conformance and remote committed-growth acknowledgement-loss replay.
