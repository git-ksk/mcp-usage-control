# Architecture

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` が担当するのは、認証済みprincipalとmetered tool executionの間にあるruntime boundaryです。

```text
identity -> entitlement/policy -> quote -> reserve -> tool -> settle
                                           ^              |
                                           |--- renew -----|
```

authentication、subscription billing、payment collection、dashboard、upstream API pricing自体は責務に含めません。

## なぜ実行前にreserveするのか

`check -> execute -> record` という設計にはtime-of-check/time-of-use raceがあります。複数のagent tool callが並列に到着すると、各requestが同じremaining balanceを確認し、どのusageも記録される前にすべて実行開始できてしまいます。

そのためstoreは単一の `reserve()` operationを公開します。production storeではquota比較、duplicate operation検出、reservation作成をatomicに実行する必要があります。

## Reservationはrenewable lease

reservation expiryはworker crash後にquotaを回収するために必要ですが、固定TTLだけでは正常な長時間toolに対して危険です。active toolがTTLを超えて実行中に別admissionがreservationを回収すると、2つのoperationが同じbudgetを消費できます。

そのためpending reservationはrenew可能なleaseとして扱います。`UsageStore.renew()` はreservationがpendingである間だけexpiryをatomicに延長し、`UsageLease.renew()` がadapter向けにそのoperationを公開します。

MCP adapterは既定でheartbeatを有効化し、handler実行中はlease TTLのおよそ3分の1間隔でrenewします。最終settlement前にはheartbeatを停止し、in-flight renewalの完了を待つことでrenewとsettleの通常raceを避けます。

MCP heartbeatを無効化するapplicationは同等のrenew mechanismを用意する責任があります。lease TTLは一時的なscheduler/event-loop stallやstorage latencyを十分上回る値にし、heartbeat intervalはTTLより十分短くしてください。

十分長いstorage/network partitionはdistributed leaseの有効期間を超える可能性があります。generic libraryから任意のupstream APIをfenceすることはできません。storage unavailable中の新規admissionはfail closedにしつつ、provider-specific fencingが必要な場合はapplication / adapter側で実装します。

## なぜsettlementはrollbackではないのか

toolはupstream resourceを消費した後で失敗することがあります。すべてのexceptionを自動refundすると、post-cost failureを繰り返すことでusageを回避できるabuse pathになります。

runtimeでは明示的なsettlementを使います。

- success: 通常はactual consumed unitsをsettleする。
- pre-cost failure: applicationが0をsettleしてよい。
- post-cost failure: すでに発生したunitsをsettleする。
- unclassified failure: MCP adapterはfull reservationを既定値とする。

v0.1 contractでは `actualUnits <= reservedUnits` が必要です。dynamic-cost toolは実行前に安全な最大値をreserveし、settlement時に未使用分をreleaseします。

## Idempotency

`operationId` はapplicationが指定します。storeはprincipal単位でscopeし、duplicate reservationを拒否します。これによりconcurrent retryやaccidental duplicate dispatchを防ぎます。

in-memory reference storeはprocess lifetime中、settled operation IDを保持します。Redis storeではrenewable reservation lease TTLとは別に、より長いconfigurable idempotency tombstone retentionを使います。

同一の `actualUnits` と `outcome` を持つsettlement replayはidempotentです。異なる2回目のsettlementは拒否します。

## Store contract

`UsageStore` はMCPやstorage vendorから独立しています。in-memory implementationはtest / local development向けです。

production storeには次が必要です。

- atomic reserve
- pending reservationに対するatomic lease renewal
- atomic settlementとunused-unit release
- reservation expiry recovery
- duplicate operation protection
- bounded idempotency retention
- ambiguous storage failure時に既定でfail openしないこと

`@mcp-usage-control/redis` はclient-side read/modify/writeではなくRedis-side Luaでこれらのtransitionを実装します。transactional keyは1つのconfigurable Redis Cluster hash slotを共有し、scriptのatomicityを保ちます。key modelとscaling trade-offは [Redis adapter](redis.ja.md) を参照してください。

## MCP adapter

`@mcp-usage-control/mcp` はpublic `@modelcontextprotocol/server` v2 APIを対象にし、core abstractionだけに依存します。

core packageはMCP SDKをimportしません。これによりaccounting semanticsを再利用可能にし、protocol / SDK changeをadapter packageへ隔離します。

adapterはtool execution errorとsettlement errorも分離します。storage writeが適用済みなのにACKだけ失われた可能性があるため、ambiguous settlementを盲目的にretryしません。

built-in heartbeatはlease renewalを補助しますが、provider-specific fencingではありません。renewal failureだけを理由に任意のupstream toolを中断することはできないため、厳密なfencingが必要なworkloadではapplication側の仕組みが必要です。

## Future multi-budget admission

production SaaSでは、たとえば次の複数constraintを同時に扱うことがあります。

- user monthly credits
- user daily credits
- tenant monthly credits
- burst / concurrency controls

現在のpre-alpha storeは1 reservationにつき1 budgetです。v0.1までにmulti-budget atomic admissionを実装し、すべてのapplicable budgetが1 transactionとして成功または失敗する設計を予定しています。