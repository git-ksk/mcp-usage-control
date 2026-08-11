# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

このroadmapはfeature数ではなく、**transactional usage-enforcement invariant** を中心に整理します。storage、MCP protocol、observability、billing exportを拡張しても、atomic admission、liability、idempotency、recovery、settlementを弱めません。

## Product boundary

core categoryはmetered execution周辺のtransactional usage / quota enforcementです。

scope内:

- atomic quota admission / reservation。
- multi-budget all-or-nothing transaction。
- liability transition、renewable / resumable lease、expiry recovery。
- idempotency / ambiguous ACK handling。
- provider-neutral observability contract。
- 上記invariantを維持するadapter。

core runtimeのscope外:

- generic request rate limiting。
- payment processing / subscription billing。
- invoice / financial-ledger storage。
- OAuth / authentication provider。
- generic MCP gateway / routing product。

external systemは明示boundaryでintegrationできますが、quota truthのfallback sourceにはしません。

## 現在の状態

### 完了済みfoundation

- atomic multi-budget core semantics。
- pending -> cost-liable -> settled lifecycle。
- renewable lease / conservative expiry recovery。
- bounded idempotency tombstone / settlement replay semantics。
- Redis production store / Cloudflare Durable Objects + SQLite store。
- provider-neutral observability lifecycle。
- MCP v2 single-round wrapper。
- verified request state + one-time server-side flow consumeによるMCP v2 `input_required` suspend/resume accounting（#14 完了）。
- Monokura -> GCP -> Cloudflare Durable Objectsのreal dogfoodによるremote accounting core path検証。

## Priority 1 — production multi-round flow storage / reconciliation

#41で追跡します。

genericな `McpUsageFlowStore` contractは存在しますが、`MemoryMcpUsageFlowStore` はprocess-localです。horizontal scaleするproduction MCP serverにはatomic compare-and-consumeを満たすshared/durable implementationが必要です。

requirements:

- mismatch callerが正規suspended flowをconsumeしない。
- 1 resume tokenでapplication再入場できるcallerは最大1つ。
- storage failureはfail-close。
- post-claim process / transport lossでhandlerをblind replayしない。
- optional completed-result reconciliationを追加する場合もusage accountingとは分離し、retention / sizeをboundする。
- destructive / external side effectはcompatible result-reconciliation layerを明示設定しない限りbusiness idempotencyを維持する。

repositoryには既にRedis production dependencyとatomic Lua transaction modelがあるため、最初のadapter候補はRedisが自然です。

## Priority 2 — real Cloudflare operational closure

#24で追跡します。

Free-plan deployed dogfood pathではreserve、liability、renewal、settlement、contention、retry / lost ACK、fail-closeを確認済みです。残りはlocal workerdでは証明できないreal-platform observationです。

- real dogfood deploymentでdocumented credential rotationを実行し、old credential reject / new credential successを確認する。
- genuine Cloudflare platform-limit / overload / Free-plan exhaustionを観測し、business `quota_exceeded` とoperationally区別されたままfail-closeすることを確認する。

2つ目を満たすためだけにshared Free-plan quotaを意図的に消費し切らないでください。

## Priority 3 — third-party store invariant test kit

将来のadapterは `UsageStore` method名を実装しただけでcompatibleをclaimできないようにします。candidate storeへtransactional contractを直接実行するreusable conformance suiteを提供する方針です。

最低限のcoverage:

- parallel final-unit contention。
- all-or-nothing multi-budget denial。
- duplicate logical operation handling。
- pending expiry release。
- liable expiry retention。
- original lease boundaryを跨ぐrenew。
- identical settlement replay / conflicting settlement rejection。
- lost / ambiguous reserve・settlement ACK expectation。
- bounded tombstone reuse。
- storage-failure fail-close。

store-specific durability / failover behaviorはatomic in-process semanticsとは分けてdocumentします。

## Priority 4 — external billing / metering adapter boundary

provider-specific billing exportは有用でも、enforcementのdownstreamに限定します。

preferred shape:

```text
UsageControl / UsageStore
        |
        v
stable provider-neutral events
        |
        +--> optional billing adapter
        +--> optional telemetry adapter
        +--> durable reconciliation pipeline
```

rules:

- billing provider schemaを `UsageStore.reserve()` transaction semanticsへ持ち込まない。
- observer delivery failureでallow / denyを変えない。
- Redis / Cloudflare failure後にexternal ledgerをdynamic quota truthへ切り替えない。
- duplicate event deliveryがあり得るdownstreamではstable idempotency keyを使う。
- financial-grade retention / reconciliationはapplication / integration responsibilityであり、enforcement core自体のclaimにしない。

## Deferred — 初回npm publication

#6で追跡します。

GitHub/source `v0.1.0` は存在しますが、npm publicationは意図的にdeferしています。Issueを閉じるためだけにpublishしません。

明示的にpublicationする場合:

1. package-name availability / ownershipを確認。
2. core / MCP / Redis / Cloudflare public contractをfinal review / freeze。
3. npm Trusted Publishing / bootstrap credentialを設定・確認。
4. explicit confirmation付きmanual publish workflowを実行。
5. registry metadata / clean-consumer installを検証。

それまではrepository checkout / local tarballがdogfood向けsupported pathです。

## 維持するnon-goal

別projectとして意図的に分離しない限り、`mcp-usage-control` を以下へ拡張しません。

- generic workflow engine。
- full MCP gateway。
- generic rate limiter。
- payment / subscription platform。
- invoice / financial ledger。
- authentication system。

隣接productを吸収するのではなく、transactional enforcement boundaryをよりportable・testable・observable・recoverableにする方向で成長させます。
