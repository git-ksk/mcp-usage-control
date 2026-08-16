# Firestoreのclock skew safety

[English](firestore-clock-skew.md) | [日本語](firestore-clock-skew.ja.md)

`FirestoreUsageStore` はlease timestampにapplication host clockを意図的に使います。Redisのようなauthoritative server-time semanticsはclaimしません。

そのためv1でsupportするFirestore deployment profileでは、**application hostのclockが同期され、skewの上限が分かっていること**を要件にします。この上限を保証できないdeploymentでは、Firestore lease recoveryを安全とみなさず、RedisやDurable Objectsのようなauthoritative time sourceを持つStoreを選んでください。

## 正確なexpiry rule

保存済み `expiresAtMs` を持つreservationは、次の場合だけexpiredと判定します。

```text
expiresAtMs <= recoveryHostNow - expiryGraceMs
```

同じ式を変形すると次です。

```text
recoveryHostNow >= expiresAtMs + expiryGraceMs
```

つまり `expiryGraceMs` は、`expiresAtMs` を最後にwriteしたhostよりrecovery hostのclockが先行している場合の安全marginです。

support範囲では次を満たすよう設定します。

```text
expiryGraceMs >= maxExpectedPositiveClockLead + clockMeasurementMargin
```

`maxExpectedPositiveClockLead` は、expiry/recoveryを実行し得る任意hostと、leaseをcreate / renewし得る任意hostの間で想定する最大の正方向clock差です。

各hostが共通time sourceに対して `±E` 以内に維持されていても、host間のworst-case差は概ね `2E` になり得ます。graceはhost単体のoffsetではなく **pairwise skew** を基準にしてください。

## 別instanceからのrenewal

`renew()` はrenewするhostのclockから次のtimestampを計算します。

```text
newExpiresAtMs = renewingHostNow + ttlMs
```

そのため遅いclockを持つhostがrenewすると、以前に速いhostが書いたtimestampより小さい値になることがあります。support済みskew envelope内ならpremature recoveryにはなりません。設定済みgraceがrenewing hostに対するrecovery hostの正方向clock差を吸収するためです。

このためclock synchronizationは単なるperformance recommendationではなくdeployment requirementです。

## TTL、network latency、scheduling

`expiryGraceMs` はclock skew用のsafety marginです。十分なlease TTLの代わりにはなりません。

lease timestampはFirestore transactionのACKが返る前にapplication hostで計算されます。そのためtransaction retry、network latency、event-loop delay、heartbeat schedulingによってnominal TTLの一部が消費されます。

`ttlMs` は、deploymentで想定する次のworst-case合計を十分に上回るようにしてください。

- Firestore transaction / network latencyとretry時間
- heartbeat / renewal interval
- event-loopやworker schedulingのjitter
- transient delayに対するoperational margin

そのうえで `expiryGraceMs` は最大pairwise clock leadを基準に別途決めます。

## Conservative failure boundary

文書化したclock-skew envelope内では次を保証する設計です。

- pending reservationをwriter基準のlease lifetimeと設定済みskew protectionより前にreleaseしない
- cost-liable reservationはexpiry後もfull chargeを維持する
- 別processからのrecoveryが早すぎるadmission capacityを作らない

このenvelope外では、Firestore dataだけから任意のhost-clock errorを検知できません。**clock skewがunknownまたはunboundedな環境はv1でsupportするFirestore deployment profileの外です。** graceを小さくしたり、不確実なrecoveryをsafe capacityのauthoritative evidenceとして扱ったりしないでください。

clock-health monitoringで設定した上限を超える可能性が出た場合、conservativeな運用はclock同期が回復するまでFirestore lease expiry/recoveryへ依存しないこと、またはauthoritative time sourceを持つbackendへenforcementを移すことです。不確実性をunmetered allowへ変換してはいけません。

## Deterministic evidence

Firestore packageには独立clockを持つmulti-instance testを追加し、次を確認します。

- producerよりrecovery hostが先行しているが `expiryGraceMs` 内に収まる場合
- 遅いclockを持つhostでrenewし、別hostからrecoverする場合
- skewしたinstance間でcost-liable reservationがexpireしてもfull reserved unitsを維持する場合

これらのtestはbounded-skew contractをproofします。任意またはunboundedなhost-clock divergenceまで安全だとはclaimしません。
