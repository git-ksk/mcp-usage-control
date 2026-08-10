# mcp-usage-control

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行向けの、同時実行に強いusage enforcement runtimeです。**

> Status: pre-alpha。APIとpackage名はまだ固定していません。

`mcp-usage-control` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するためのprovider-neutralなruntimeです。

決済、MCP Gateway、OAuth、一般的なrate limiting自体を目的にはしていません。agentのretry、parallel tool call、timeout、upstream cost発生後の失敗などで、usage accountingが壊れないことを目的にしています。

## 基本ライフサイクル

```text
principal -> policy/entitlement -> quote -> atomic reserve -> execute -> settle
```

重要なのは、失敗時に自動rollbackするのではなく、**settleで実消費量を確定する**ことです。toolが失敗しても、その前に外部API・DB・compute costが発生している場合があります。

## 現在の構成

- `@mcp-usage-control/core`
  - principal単位のadmission
  - policyによるcredit quote
  - tool実行前のreservation
  - outcome-aware settlement
  - duplicate operation防止
  - reservation TTL
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - `@modelcontextprotocol/server` v2 adapter
  - error時は予約分を消費する保守的な既定値
  - 実消費量を明示分類するhook

pre-alpha中はpackage名確定前の誤publishを防ぐため、workspace packageはprivateにしています。

## Safety invariants

1. quota checkとreservationは1つのstore operationとして扱います。
2. 同一principal / operation IDで二重reservationを作りません。
3. v0.1ではactual unitsはreserved unitsを超えられません。
4. 同じsettlementの再送はidempotent、異なるsettlementはerrorにします。
5. TTLを超えた未settle reservationは解放します。
6. errorは明示分類されない限り予約分を消費します。

詳しくは [Architecture](docs/architecture.md) を参照してください。

## v0.1予定

- Redis atomic adapter
- daily + monthly + tenantなどのmulti-budget admission
- operation tombstone / expiry policy
- observability hook
- MCP integration example
- npm package名とrelease workflow

OpenMeter、Unkey、Stripe、RevenueCat、x402などはcore dependencyではなくadapter候補として扱います。

## License

Apache-2.0
