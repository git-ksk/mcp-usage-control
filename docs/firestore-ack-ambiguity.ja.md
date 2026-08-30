# FirestoreのACK ambiguity semantics

[English](firestore-ack-ambiguity.md) | [日本語](firestore-ack-ambiguity.ja.md)

`FirestoreUsageStore` はauthoritativeなstate changeにFirestore transactionを使います。clientからerrorが見えたとしても、transactionがcommitされなかったとは限りません。writeはdurableにcommit済みで、その後のACKだけが失われた可能性があります。

この文書は、そのambiguityに対するsupport済みのsafety boundaryを定義します。adapterは**ambiguousなstate-changing resultをunmetered allowへ変換せず**、自動で2つ目のreservationを作りません。

## Reserve

`reserve()` が、Firestore側ではcommitされた可能性を残したままtransport/client errorになった場合、callerはadmission resultをunknownとして扱い、fail closedにします。

reconciliation目的でretryする場合も、**同じlogical operation identity** を使います。元のreservationがcommit済みなら、retryは `duplicate_operation` になる想定です。この結果は「そのoperation identityがauthoritative usage stateにすでに存在する」ことを示すだけで、新しいadmission成功ではありません。これを根拠にmeteredなbusiness workを開始してはいけません。

`duplicate_operation` を回避するためだけに新しい `operationId` を生成してはいけません。別accounting operationとして扱われ、capacityを二重にreserveする可能性があります。

`FirestoreUsageStore` はv0.13でscalar `OperationReconciliationStore` と `VectorOperationReconciliationStore` を実装しています。initial reserve ACKが曖昧な場合は、同じtrusted logical operation identityとexpected units / budget topologyを使ってread-only reconciliationを行い、authoritative retained stateを確認できます。reconciliation自体は新しいreservationを作らず、business operationの再実行も許可しません。stateを証明できない場合はindeterminateとしてfail closedします。

## `markLiable()`

callerは、confirm済みadmissionからreservation IDをすでに持っています。`markLiable()` のACKがambiguousなら、同じreservationに対してactiveな間に `markLiable()` をretryします。

このtransitionはsafety上idempotentです。繰り返しても別reservationや追加chargeは作りません。retryでactive reservationを確認できない場合、最初のcallがcommitしたと推測してmetered workを開始してはいけません。

liability transitionがcommit済みなら、その後はconservativeに扱われます。execution開始後の可能性があるため、expiry recoveryはreserved amountをoptimisticにrefundしません。

## `renew()`

`renew()` のACKが失われた場合でも、長いlease自体はcommit済みかもしれません。同じreservationへの `renew()` retryはsafeです。後のretryによって最初のattemptよりleaseがさらに延びることがありますが、quota enforcementとしてはconservativeで、追加usage unitをallocateするわけではありません。

work継続中にrenewalをconfirmできない場合、applicationはexecution policyに従って停止するなどfail closedにします。unknownなlease延長が成功したと仮定してはいけません。

## `settle()`

settlement reconciliationは既存のidempotent terminal replay ruleを使います。

settlement ACKがambiguousになったら、同じ `reservationId`、`actualUnits`、`outcome` でexact replayします。settlement tombstoneが保持されている間、identical replayは同じsettlement resultを返します。conflicting replayはrejectされます。

成功responseを得るためにactual usageやoutcomeを変更してはいけません。またunderlying business operationをreplayしてはいけません。business-result recoveryは `UsageStore` の外側です。

## Caller matrix

| Ambiguous operation | Support済みrecovery | Safety boundary |
| --- | --- | --- |
| `reserve()` | 同じlogical identityでretry。最初のcommitが成立していればfail-closedな `duplicate_operation` | automatic resumeやsecond reservationなし。duplicate resultからmetered workを開始しない |
| `markLiable()` | activeな間、同じreservationへretry | liability transitionをconfirmできるまでmetered workを開始しない |
| `renew()` | 同じreservationへretry | 後のexpiryはconservative。unknown renewalを成功扱いしない |
| `settle()` | exact same terminal settlementをreplay | identical replayだけを受け入れ、conflictはfail closed |

## Testでproofすること

Firestore packageには、transactionをtest databaseへcommitした直後にcallerへerrorを返すfault-injection coverageを追加しています。reserve、liability、renewal、settlementを対象に、次を確認します。

- commit済みreserveがduplicateされず、capacityを引き続き消費する
- liabilityは同じreservationで安全にretryできる
- commit済みrenewalはACK喪失後も有効なまま残る
- commit済みsettlementはidentical replayでreconcileでき、conflicting replayはrejectされる

これはFirestore adapterのacknowledgement ambiguity contractに対するevidenceです。任意のbusiness side effectをreplayできるという主張でも、すべてのFirestore/network failureをlost ACKと判別できるという主張でもありません。
