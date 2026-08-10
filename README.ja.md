# mcp-usage-control

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行向けの、同時実行に強いusage enforcement runtimeです。**

> Status: pre-alpha。APIとpackage名はまだ固定していません。

`mcp-usage-control` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するためのprovider-neutralなruntimeです。

決済、MCP Gateway、OAuth、一般的なrate limiting自体を目的にはしていません。agentのretry、parallel tool call、timeout、長時間実行、upstream cost発生後の失敗などでusage accountingが壊れないことを目的にしています。

## 基本ライフサイクル

```text
principal -> policy/entitlement -> quote -> atomic reserve -> execute -> settle
                                                ^              |
                                                |--- renew -----|
```

重要なのは、失敗時に自動rollbackするのではなく、**settleで実消費量を確定する**ことです。toolが失敗しても、その前に外部API・DB・compute costが発生している場合があります。

reservationはrenew可能なleaseとして扱います。MCP adapterはhandler実行中に自動heartbeatするため、正常な長時間toolが単純なTTL超過だけで誤回収されることを防ぎます。

## 現在の構成

- `@mcp-usage-control/core`
  - principal単位のadmission
  - policyによるcredit quote
  - tool実行前のreservation
  - renewable lease
  - outcome-aware settlement
  - duplicate operation防止
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - `@modelcontextprotocol/server` v2 adapter
  - lease heartbeatを既定で有効化
  - error時は予約分を消費する保守的な既定値
  - 実消費量を明示分類するhook
  - 曖昧なsettlement failureを盲目的に再試行しない
- `@mcp-usage-control/redis`
  - Luaによるatomic reserve / renew / settle
  - expiry / idempotency stateのbounded cleanup
  - budget / operation識別子をSHA-256化
  - Redis Clusterで同一hash-slotに収まるtransaction domain
  - CIで実Redis integration testを実施

pre-alpha中はpackage名確定前の誤publishを防ぐため、workspace packageはprivateにしています。

## Safety invariants

1. quota checkとreservationは1つのstore operationとして扱います。
2. 同一principal / operation IDで二重reservationを作りません。
3. 長時間実行中のactive reservationはrenewし、初回TTLだけを理由に回収しません。
4. v0.1ではactual unitsはreserved unitsを超えられません。
5. 同じsettlementの再送はidempotent、異なるsettlementはerrorにします。
6. 放棄された期限切れreservationはreserved unitsを解放します。
7. errorは明示分類されない限り予約分を消費します。
8. 曖昧なsettlement failureは表面化させ、盲目的に再実行しません。
9. storage failureをallow判定へ変換しません。

詳しくは [Architecture](docs/architecture.md)、Redis固有の設計は [Redis adapter](docs/redis.md) を参照してください。

## v0.1予定

- daily + monthly + tenantなどのatomic multi-budget admission
- operation tombstone / expiry semanticsの確定
- observability hook
- MCP integration example
- npm package名とrelease workflow

OpenMeter、Unkey、Stripe、RevenueCat、x402などはcore dependencyではなくadapter候補として扱います。

## License

Apache-2.0
