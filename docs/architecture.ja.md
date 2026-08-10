# Architecture — v0.1

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` が担当するのは、trustedなaccounting principalとmetered tool executionの間にあるenforcement boundaryです。

```text
identity -> entitlement/policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                          ^                 |
                                                          |------ renew -----|
```

authentication、subscription billing、payment collection、dashboard、generic rate limiting、upstream pricingは責務外です。

## なぜexecution前にreserveするのか

`check -> execute -> record` にはtime-of-check/time-of-use raceがあります。並列agent callが同じremaining balanceを確認し、どのcallもusageを記録する前にすべて実行開始できるためです。

そのため `UsageStore.reserve()` はduplicate検出、quota比較、reservation作成を1つのatomic store operationとして実行します。

## Multi-budget admission

1 invocationへ複数budgetを適用できます。例:

```text
user daily
user monthly
tenant monthly
```

v0.1ではinvocationに1つのunit quoteを決め、そのamountを**参加する全budgetへatomicにreserve**します。どれか1 budgetでもdenyする場合、他budgetだけがpartial reservationされた状態を残してはいけません。

budget keyはadmission前にcanonicalizeします。empty list / duplicate budget keyはrejectします。1 budget用の `budget` quote formは内部で1要素listとして扱います。

burst rate limit / concurrency capはv0.1では別concernです。applicationがusage budgetとして明示的にmodelする場合を除きcoreは混同しません。

## Pendingとcost-liable lease

reservationは **pending** から開始します。capacityは確保済みですが、まだmetered execution boundaryへ入っていません。

metered work開始直前に `UsageLease.markLiable()` を呼びます。MCP adapterはapplication handler entry直前に実行します。

expiry behaviorはstate-dependentです。

- **pending expiry** — 参加する全budgetからreservationを解放し、abandoned operationのactive replay protectionを除去する。
- **cost-liable expiry** — 参加する全budgetでfull reservationを維持し、`lease_expired_after_execution_started` としてsettled化し、idempotency tombstone期間replay protectionを残す。

これによりcrash-after-cost refundを防ぎます。generic MCP wrapperはprovider-specificなcost発生点を知らないためhandler entryをliability boundaryにします。このためhandler entry後・実upstream cost前のcrashは保守的にover-accountする可能性があります。より正確なboundaryが必要ならcore lifecycleを直接利用してください。

## Renewable lease

固定TTLだけではlong-running workに危険です。実行中reservationをreclaimすると別operationが同じbudget capacityを再利用できてしまいます。

`UsageStore.renew()` はactive leaseをatomicに延長します。`mcp-usage-control-mcp` はwrapped handler実行中defaultでheartbeatを行い、settlement前にheartbeatを止め、in-flight renewalの完了を待ちます。

storage/network partitionがleaseより長く続く可能性はあります。renewalはprovider-specific fencingではありません。lease loss直後にupstream workを止める必要があるapplicationはmetered resource boundaryでfencing / cancellationを実装してください。

## Settlementでありrollbackではない

toolはmetered resource消費後に失敗する可能性があります。すべてのerrorをautomatic refundするとabuse pathになります。

v0.1のsettlement rule:

- success -> actual consumed unitsをsettle。
- proven pre-cost failure -> 0を許可。
- post-cost failure -> incurred unitsをsettle。
- unclassified MCP failure -> defaultはfull reservation。
- cost classifier failure -> full reservationをsettleしてから `UsageClassificationError` を表面化。

`actualUnits` はnon-negative safe integerかつ `reservedUnits` 以下です。dynamic-cost toolはsafe maximumをreserveし、settlement時にunused分をreleaseします。

settlementはreservationに参加した全budgetへ同じactual unit countを適用します。

## Idempotency / replay protection

v0.1のlogical operation scope:

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` はapplicationが指定し、同じlogical invocationのretryではstableである必要があります。authentication proofではありません。

identifierはstorage/hash化前に曖昧性のないtupleとしてencodeするためdelimiter入りvalueでもcollisionしません。

active operationへのduplicate reserveはrejectします。settled operationはbounded tombstone期間replay protectionされ、Memory / Redis storeのdefaultは24時間です。tombstone expiry後は同scopeでも同じoperation IDを再利用できます。

settlement replayもidempotentです。同じ `actualUnits` + `outcome` はprevious settlementを返し、conflicting replayはfailします。

## Store contract

coreはMCP / storage vendorから独立です。production `UsageStore` には次が必要です。

- all-or-nothing atomic multi-budget reserve。
- atomic pending -> cost-liable transition。
- atomic active-lease renewal。
- 全budgetに対するatomic settlement / release。
- 1 reservationが複数budgetへ影響してもexactly-once-styleでexpiry recoveryすること。
- scoped duplicate-operation protection。
- bounded settled replay retention。
- ambiguous storage failureで保守的に動作すること。

`MemoryUsageStore` はreference semanticsでありdistributed production storeではありません。

`mcp-usage-control-redis` は1つのconfigurable Redis Cluster hash slot内でRedis-side Luaによりcontractを実装します。lease / tombstone判定にはRedis server `TIME` を使い、application hostのclock skewがaccountingを変えないようにします。

## Redis atomicityとdurability

LuaはRedis内部のatomic transitionを提供しますが、あらゆるcrash / failover / acknowledged-write-loss windowでのpersistenceを単独では保証しません。productionでは許容accounting lossに合わせてpersistence、replication、failover、backup、recoveryを構成してください。

より強いfinancial ledgerが必要ならRedisをenforcement stateとして使い、別のdurable ledger / event systemへreconcileします。

## MCP result semantics

`mcp-usage-control-mcp` は `@modelcontextprotocol/server` v2 **single-round** tool handlerを対象にし、coreはSDK非依存です。

adapterは次を区別します。

- normal result。
- `{ isError: true }` tool result。
- thrown execution error。
- cost-classification error。
- settlement error。

ambiguous settlementはblind retryしません。store writeがcommit済みでACKだけ失った可能性があるためです。

repositoryではdirect wrapper testと公式SDK `Client + createMcpHandler` pathの両方をtestします。

### `input_required`

MCP v2 `input_required` はrequest boundaryを跨ぎます。正しいaccountingにはround間のreservation suspend/resume、replay identity、abandonment recovery、client-carried stateのintegrity ruleが必要です。

そのためv0.1ではsupport boundaryを明示します。`protectTool()` は **`input_required` 未対応**です。wrapped handlerが返した場合はcurrent reservationを保守的にsettleし `UnsupportedMcpUsageFlowError` を返します。real suspend/resume supportはIssue #14で追跡します。

## Trust boundary

- principal / tenant identityはtrustedなserver-side authentication/application contextから取得する。
- `clientInfo`、tool args、request-state blob、operation IDをauthorization proofにしない。
- policy denial detailへmodel/end userに出したくないsecretを入れない。
- log / metricへ出すbudget key / outcomeはlow-cardinality / non-sensitiveにする。
- Redis key nameのhashingはidentifier exposureを減らすだけでencryptionではない。
