# Architecture

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` が担当するのは、認証済みprincipalとmetered tool executionの間にあるruntime boundaryです。

```text
identity -> entitlement/policy -> quote -> reserve -> mark liable -> execute -> settle
                                                   ^                 |
                                                   |------ renew -----|
```

authentication、subscription billing、payment collection、dashboard、upstream API pricing自体は責務に含めません。

## なぜ実行前にreserveするのか

`check -> execute -> record` という設計にはtime-of-check/time-of-use raceがあります。複数のagent tool callが並列に到着すると、各requestが同じremaining balanceを確認し、どのusageも記録される前にすべて実行開始できてしまいます。

そのためstoreは単一の `reserve()` operationを公開します。production storeではquota比較、duplicate operation検出、reservation作成をatomicに実行する必要があります。

## Pendingとcost-liable lease

reservationは最初 **pending** stateです。pendingはcapacityを確保したものの、metered execution boundaryにはまだ入っていない状態を表します。pending leaseがexpireした場合、metered workをcost-liableと宣言していないためreserved unitsを解放できます。

metered execution開始前に、callerは `UsageLease.markLiable()` でleaseを **cost-liable** に遷移させます。MCP adapterはapplication handlerへ入る直前にこれを実行します。cost-liableになった後のexpiryは保守的に扱い、full reservationを消費済みとして維持し、operationを `lease_expired_after_execution_started` でsettledにします。

これによりcrash-after-costの穴を塞ぎます。このstateがなければ、upstream APIを呼んだ後にprocessが消え、settlement前にworkerが失われた場合でも、後から「何も実行されなかった」ようにquotaがrefundされてしまいます。

generic MCP wrapperはprovider-specificな「実コスト発生点」を知らないため、handler entryをcost-liable boundaryとして扱います。そのため、handlerへ入った直後で実upstream cost発生前にcrashすると保守的にover-accountする可能性はありますが、既定ではunder-accountingを避けます。より遅く正確なcost-liability boundaryが必要なapplicationはcore lifecycleを直接利用するかprovider-specific adapterを用意してください。

## Reservationはrenewable lease

reservation expiryはworker消失後にcapacityを回収するために必要ですが、固定TTLだけでは正常な長時間toolに対して危険です。active toolがTTLを超えて実行中に別admissionがreservationを回収すると、2つのoperationが同じbudgetを消費できます。

`UsageStore.renew()` はactive reservationのexpiryをatomicに延長します。MCP adapterは既定でheartbeatを有効化し、handler実行中はlease TTLのおよそ3分の1間隔でrenewします。最終settlement前にはheartbeatを停止し、in-flight renewalの完了を待つことでrenewとsettleの通常raceを避けます。

十分長いstorage/network partitionはdistributed leaseの有効期間を超える可能性があります。built-in heartbeatはrenewal convenienceでありprovider-specific fencingではありません。renewal errorだけを理由に任意のupstream workを自動cancelしません。ただしleaseは既にcost-liableなので、expiry時にはrefundせず保守的にfull reservationを維持します。ownershipを失った場合は最終settlementでexpired/lost leaseが表面化します。

lease loss直後に処理を停止する必要があるworkloadは、metered resource boundaryでapplication側のfencing/cancellationを実装してください。

## なぜsettlementはrollbackではないのか

toolはupstream resourceを消費した後で失敗することがあります。すべてのexceptionを自動refundすると、post-cost failureを繰り返すことでusageを回避できるabuse pathになります。

runtimeでは明示的なsettlementを使います。

- success: 通常はactual consumed unitsをsettleする。
- pre-cost failure: metered resource未消費を証明できる場合に0をsettleできる。
- post-cost failure: すでに発生したunitsをsettleする。
- unclassified failure: MCP adapterはfull reservationを既定値とする。
- cost-classification failure: MCP adapterはfull reservationをsettleしたうえで `UsageClassificationError` を表面化する。

現在のcontractでは `actualUnits <= reservedUnits` が必要です。dynamic-cost toolは実行前に安全な最大値をreserveし、settlement時に未使用分をreleaseします。

## MCP tool-result semantics

MCPには複数のfailure/result shapeがあります。adapterは明示的な `{ isError: true }` tool resultをsuccessではなくtool errorとして扱います。`toolErrorUnits` hookでactual costを分類でき、未指定時は保守的にfull reservationを消費します。

MCP v2には、clientが入力を集めてfresh requestでhandlerへ再入場する `input_required` もあります。これを正しくaccountingするにはroundを跨ぐsuspend/resume semanticsが必要です。そのためpre-alphaの `protectTool()` は **まだ `input_required` をサポートしません**。wrapped handlerが返した場合は、silentな二重課金やduplicate operation deadlockを避けるためreservationを保守的にsettleし、`UnsupportedMcpUsageFlowError` を返します。

multi-round reservation resumeはv0.1向けの別設計項目として追跡します。

## Idempotency

`operationId` はapplicationが指定します。現在のstoreはprincipal単位でscopeし、duplicate reservationを拒否します。内部operation keyはstorage/hash化の前に曖昧性のないtuple encodingを使うため、delimiterを含むidentifier同士でもcollisionしません。

in-memory reference storeはprocess lifetime中、settled operation IDを保持します。Redis storeではrenewable lease TTLとは別に、configurable idempotency tombstone retentionを使います。

同一の `actualUnits` と `outcome` を持つsettlement replayはidempotentです。異なる2回目のsettlementは拒否します。

principal / tenant / toolをどこまでoperation scopeへ含めるかはv0.1前に引き続き確定します。`operationId` はidempotency inputであり、authentication proofではありません。

## Store contract

`UsageStore` はMCPやstorage vendorから独立しています。in-memory implementationはtest / local development向けです。

production storeには次が必要です。

- atomic reserve
- atomic pending -> cost-liable transition
- active reservationに対するatomic lease renewal
- atomic settlementとunused-unit release
- state-dependent expiry recovery
- duplicate operation protection
- bounded idempotency retention
- ambiguous storage failure時に既定でfail openしないこと

`@mcp-usage-control/redis` はclient-side read/modify/writeではなくRedis-side Luaでこれらのtransitionを実装します。transactional keyは1つのconfigurable Redis Cluster hash slotを共有し、scriptのatomicityを保ちます。lease timestampはLua内のRedis server timeから計算するため、application hostのclock skewがexpiry判定へ影響しません。

ただしatomicityとdurabilityは別です。Redis persistence、replication、failover、acknowledged write lossのwindowはdeployment側の保証です。必要なaccounting guaranteeに合わせてRedis構成を選ぶ必要があります。詳しくは [Redis adapter](redis.ja.md) を参照してください。

## MCP adapter

`@mcp-usage-control/mcp` はpublic `@modelcontextprotocol/server` v2 APIのsingle-round tool handlerを対象にします。core packageはMCP SDKをimportしないため、protocol / SDK changeをadapter packageへ隔離できます。

adapterはexecution error、classification error、settlement errorを区別します。storage writeが適用済みなのにACKだけ失われた可能性があるため、ambiguous settlementを盲目的にretryしません。

repositoryではdirect wrapper testに加え、公式SDKの `Client + createMcpHandler` in-process pathでもadapterを実行し、SDK側のerror/result変換まで含めてtestします。

## Future multi-budget admission

production SaaSではuser monthly credits、daily credits、tenant monthly credits、burst/concurrency controlなど複数constraintを同時に扱うことがあります。

現在のpre-alpha storeは1 reservationにつき1 budgetです。v0.1までにmulti-budget atomic admissionを実装し、すべてのapplicable budgetが1 transactionとして成功または失敗する設計を予定しています。