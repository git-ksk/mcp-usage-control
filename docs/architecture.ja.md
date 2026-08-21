# Architecture — current source

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` が担当するのは、trustedなaccounting principalとmetered tool executionの間にあるenforcement boundaryです。

```text
identity -> entitlement/policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                          ^                 |
                                                          |------ renew -----|
```

projectのcategoryは **transactional usage / quota enforcement** です。execution周辺のadmission、liability、lease recovery、settlementを扱います。

authentication、subscription billing、payment collection、dashboard、generic rate limiting、gateway routing、upstream pricingは責務外です。

external billing / metering integrationはenforcement transactionの外側に置きます。

```text
transactional enforcement core -> stable observer/event contract -> optional billing/telemetry adapter
```

external schemaはstableなoutcomeをconsumeできますが、reserve / liability / idempotency / expiry / settlement semanticsを再定義・弱体化してはいけません。

## なぜexecution前にreserveするのか

`check -> execute -> record` にはtime-of-check/time-of-use raceがあります。並列agent callが同じremaining balanceを確認し、どのcallもusageを記録する前にすべて実行開始できるためです。

例えば残り1 unitのとき、2 requestが同時に `remaining = 1` を読み、両方がmetered upstream operationを実行してからusageをincrementすると、1 unitのcapacityに対して2 unitsのreal workをadmitしてしまいます。

そのため `UsageStore.reserve()` はduplicate検出、quota比較、reservation作成をexecution**前**の1つのatomic store operationとして実行します。これが通常のrequest rate limiterとの主要な違いです。

## Multi-budget admission

1 invocationへ複数budgetを適用できます。例:

```text
user daily
user monthly
tenant monthly
```

v0.1ではinvocationに1つのunit quoteを決め、そのamountを**参加する全budgetへatomicにreserve**します。どれか1 budgetでもdenyする場合、他budgetだけがpartial reservationされた状態を残してはいけません。

budget keyはadmission前にcanonicalizeします。empty list / duplicate budget keyはrejectします。1 budget用の `budget` quote formは内部で1要素listとして扱います。

### Application-owned budget semantics

budget namingはStore behaviorではなくapplication policyです。同じ `budget.key` は同じaccounting bucketを表し、異なるkeyは別bucketを表します。そのためCore / built-in Storeはdaily / monthly / lifetime分類、reset date、安全なhistorical retention horizonを推測しません。time-window policyはwindowをkeyへ含め、historical non-zero budget stateの削除はstill-valid bucketをresetしないことをapplicationが保証するlifecycle decisionとして扱います。

burst rate limit / concurrency capはv0.1では別concernです。applicationがusage budgetとして明示的にmodelする場合を除きcoreは混同しません。

## Pendingとcost-liable lease

reservationは **pending** から開始します。capacityは確保済みですが、まだmetered execution boundaryへ入っていません。

metered work開始直前に `UsageLease.markLiable()` を呼びます。MCP adapterはapplication handler entry直前に実行します。

expiry behaviorはstate-dependentです。

- **pending expiry** — 参加する全budgetからreservationを解放し、abandoned operationのactive replay protectionを除去する。
- **cost-liable expiry** — 参加する全budgetでfull reservationを維持し、`lease_expired_after_execution_started` としてsettled化し、idempotency tombstone期間replay protectionを残す。

これによりcrash-after-cost refundを防ぎます。generic MCP wrapperはprovider-specificなcost発生点を知らないためhandler entryをliability boundaryにします。このためhandler entry後・実upstream cost前のcrashは保守的にover-accountする可能性があります。より正確なboundaryが必要ならcore lifecycleを直接利用してください。

## Renewable / resumable lease

固定TTLだけではlong-running workに危険です。実行中reservationをreclaimすると別operationが同じbudget capacityを再利用できてしまいます。

`UsageStore.renew()` はactive leaseをatomicに延長します。`mcp-usage-control-mcp` はwrapped handler実行中defaultでheartbeatを行い、settlementまたはmulti-round suspension前にheartbeatを止め、in-flight renewalの完了を待ちます。このwrapperを使わずreservation TTLを超える可能性があるintegrationは、authoritativeなrenewal loopを自前で実装しなければなりません。固定TTLを大きくするだけではrenewable-lease lifecycleの代替にはならず、deployment trade-offに留まります。

`UsageLease.toResumeState()` / `UsageControl.resumeLease()` はpolicy quote / reserveを再実行せず、trusted server-side stateから既存leaseへreattachする仕組みです。raw resume stateはclient credentialではなく、そのように扱ってはいけません。

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

## Failure / crash / ACK ambiguity

state-changing operationはremoteで成功していてもcallerがACKを受け取れない場合があります。どのtransitionがambiguousになったかで安全な扱いが変わります。

### Liability前のcrash

leaseがpendingのままprocessが消えた場合、expiryでreservationを解放します。metered execution boundaryへ入った宣言がないためです。

### Liability後のcrash

`markLiable()` 後にprocessが消えた場合、expiryでfull reserved chargeを維持します。metered resourceを消費していないと安全に断定できません。

### Reserve ACK loss

`reserve()` 後のtimeoutは「commitされていない」場合と「commit済みでACKだけlost」の両方があります。availabilityを戻すために無関係なsecond reservationを作ってはいけません。store-specific reconciliationまたはstable logical-operation replayでoriginal reservationの存在を確認します。

### Settlement ACK loss

`settle()` 後のtimeoutもsettlement commit済みの可能性があります。different settlementをblindに発行するのは危険です。identical settlement replayはtombstone retention中idempotentで、conflicting replayはfail-closeします。

### Multi-round token claim後のfailure

MCP `input_required` resume tokenはapplicationへ再入場する前にone-time consumeされます。claim後にprocess / transportがfailした場合、wrapperはapplication handlerをblindに再実行しません。usage leaseは保守的に扱われ、completed business resultのreplayが必要なら別のbusiness idempotency / result reconciliation layerが必要です。

このようなcaseがあるためruntimeはrequest counterではなくstate machineとして設計されています。

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

将来のthird-party store compatibility kitでは、method名が一致するだけでcompatibilityをclaimできないよう、これらのinvariantを直接実行するconformance testを提供する方針です。

## Enforcement stateとfinancial ledger

atomic enforcement stateが答えるのは「workを開始してよいか」「reserved capacityをどうfinalizeするか」です。それだけでfinancial-grade ledgerになるわけではありません。

Redis、Durable Objects等のenforcement storeはinvoice / statutory record向けaccounting systemとは異なるpersistence / failover propertyを持ち得ます。より強いdurabilityが必要なら、admissionのauthoritative sourceはenforcement stateのままにし、stable enforcement outcomeを別durable ledger / event systemへreconcileします。

reconciliationはdownstreamです。enforcement store failure後にbilling ledgerをdynamic fallback quota storeとして利用するとsource of truthが分裂しquota oversubscriptionを起こし得るため、行いません。

## MCP result semantics

`mcp-usage-control-mcp` は `@modelcontextprotocol/server` v2を対象にし、coreはSDK非依存です。

adapterは次を区別します。

- normal result。
- `{ isError: true }` tool result。
- thrown execution error。
- cost-classification error。
- settlement error。
- `protectMultiRoundTool()` による明示的multi-round `input_required` suspend/resume。

ambiguous settlementはblind retryしません。store writeがcommit済みでACKだけ失った可能性があるためです。

repositoryでは両wrapperのdirect testと公式SDK `Client + createMcpHandler` pathの両方をtestします。

### `input_required`

`protectTool()` は意図的にsingle-roundのままで、`input_required` を保守的にrejectします。

`protectMultiRoundTool()` がopt-inのmulti-round contractを提供します。初回roundだけreserve / mark liableし、suspended stateはserver-sideに保持します。wire `requestState` はintegrity-protectedなopaque referenceです。resumeにはMCP server verification hookと、principal / tool / args bindingを考慮したatomic flow consumeが必要です。resume roundはquote / reserveを再実行せずoriginal leaseへreattachします。

`MemoryMcpUsageFlowStore` はprocess-local reference semanticsです。horizontal scaleするserverには同じatomic compare-and-consume contractを持つshared/durable flow storeが必要です。post-claim crash後のcompleted-result replayはone-time resume-token semanticsを弱めず、別reconciliation concernとして扱います。

## Trust boundary

- principal / tenant identityはtrustedなserver-side authentication/application contextから取得する。
- `clientInfo`、tool args、request-state blob、operation IDをauthorization proofにしない。
- clientを往復したMCP request stateはintegrity verification後、trusted server-side flow stateへrebindしてからaccountingへ影響させる。
- policy denial detailへmodel/end userに出したくないsecretを入れない。
- log / metricへ出すbudget key / outcomeはlow-cardinality / non-sensitiveにする。
- storage / key nameのhashingはidentifier exposureを減らすだけでencryptionではない。
- external billing / metering adapterはstable outcomeをobserveできるが、enforcement decisionやtransaction semanticsを変更してはいけない。
