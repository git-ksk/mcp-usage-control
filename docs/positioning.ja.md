# Project positioning

[English](positioning.md) | [日本語](positioning.ja.md)

`mcp-usage-control` は、**MCPサーバ向けのfailure-safeなtransactional usage enforcement library** です。

単にrequest回数を数えたり、agentへbudgetを付けたりすることが目的ではありません。同時実行、retry、process loss、lease expiry、ACK不明といった分散システム上のfailureが起きても、usage / quota invariantを崩さないことを目的にしています。

## Core promise

core lifecycleは次です。

```text
policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                   ^                 |
                                                   |------ renew -----|
```

差別化の中心は、次を組み合わせて保証することです。

- metered work開始前のatomicなall-or-nothing admission;
- 明示的な `pending -> cost-liable` transition;
- stateに応じたexpiry recovery;
- 実行開始後のcrash / lost-ACK ambiguityを安全側に扱うこと;
- logical operationのidempotent replayとconflicting settlement rejection;
- 2回目のreservationを作らないMCP single-round / multi-round integration;
- billing source of truthへ変質しないprovider-neutralなStore / observability。

これはexecutionの周囲に置くcorrectness layerであり、general-purposeなbudget-management productではありません。

## `cost-liable` が重要な理由

metered work開始前にreservationがexpireした場合は、予約した利用枠を安全に戻せます。一方、execution boundaryを越えた後にexpireした場合は、upstream API、database、compute jobなどの実コストが発生したかを証明できない可能性があります。

`mcp-usage-control` はその2つを明確に分けます。

```text
pending lease expires      -> reserved capacityをrelease
cost-liable lease expires  -> conservativeなfull chargeを保持
```

このtrade-offは、execution outcomeが不明な場合にoptimistic availabilityよりquota correctnessを優先するものです。

## Competitive boundary

より広いagent-budget、gateway、billing、governance platformの機能面を追いかけて、同じproduct surfaceを作ることは目標にしません。

それらのsystemはdashboard、pricing catalog、組織横断budget管理、payment flow、routing、policy engine、multi-language agent integrationなどを提供できます。価値のある隣接領域ですが、このlibraryのroadmap templateではありません。

`mcp-usage-control` は狭く、組み込みやすいまま維持します。最も強いpositioningは次です。

> **MCP execution boundaryでtransactional usage invariantを守る。特にfailureとretryのときに崩さない。**

新機能はこのpositioningに照らして判断します。admission、liability、settlement、replay、recovery、MCP execution boundaryを強くするものはcore候補です。gatewayやbilling platform化する機能はcoreへ入れません。

隣接製品とのevidence-basedな継続比較は [競合capability map](competitive-capabilities.ja.md) を参照してください。

## MCP-native direction

MCP固有の開発は、accounting correctnessへ直接影響するprotocol semanticsを優先します。

- current MCP protocol / SDK behaviorとの明示的なconformance;
- fresh requestとして再試行されるmulti-round flowでduplicate reservationを作らないこと;
- integrity-verified request stateとtrusted principal / tool / argsへの再binding;
- horizontal scale可能なresume / reconciliation semantics;
- task lifetimeとreservation / lease lifetimeを結びつける必要があるlong-running MCP Tasks;
- 同じaccounting guaranteeを維持できる場合のstateless-friendly design。

stateless transportだからaccountingまでstatelessである必要はありません。atomic quota enforcementにshared stateが必要なら利用します。目的は、MCP adapterへ不要なsession affinityやworkflow stateを持ち込まないことです。

## Coreの外に置くもの

coreは次にはしません。

- generic agent runtime / agent budget authority;
- generic HTTP / API rate limiter;
- MCP gateway / router;
- payment processor、checkout system、subscription manager;
- billing dashboard / pricing catalog;
- OAuth / identity provider;
- financial-grade ledger;
- vendor-specific billing / metering protocol implementation;
- arbitraryなbusiness side effectをreplayするworkflow engine。

これらとのintegrationはadapterで提供できますが、外部systemのterminologyやdelivery guaranteeによってatomic admission、liability、replay、expiry、settlement semanticsを弱めません。

## Roadmap test

大きな機能を追加する前に、次を確認します。

1. concurrency、retry、crash、ambiguous ACKのときにquota admission / settlementをより安全にするか。
2. gateway ownershipを要求せずMCP-native correctnessを改善するか。
3. core state-machine boundaryでprovider-neutralを維持できるか。
4. 明示的な `cost-liable` invariantを守れるか。
5. third-party Store compatibility testでその保証を検証できるか。

ほとんどがNoなら、その機能はcore runtimeではなくadapter、example、または別projectに置く方が適切です。
