# Operation reconciliation / status

[English](operation-reconciliation.md) | [日本語](operation-reconciliation.ja.md)

Status: **v0.8 contract。future v1 surfaceへoptionalなscalar Store capabilityとして採用。**

`mcp-usage-control` では、state-changing Store callのACKが曖昧になった場合をcorrectness上の事象として扱います。最初のcallがcommitしたか分からないという理由だけで、別reservationを新規作成してはいけません。

v0.8ではprovider-neutralな小さい **read-only** scalar operation status語彙を追加します。base `UsageStore` はsource-compatibleのままで、Storeは `OperationReconciliationStore`、またはCloudflare remote reconciliation helperのようなadapter固有の同等capabilityとしてopt-inします。

## Core types

```ts
import type {
  OperationReconciliationStore,
  UsageOperationReconciliation,
  UsageOperationReconciliationInput,
} from 'mcp-usage-control';
```

`UsageOperationReconciliationInput` は、信頼済みの元logical operation identityと、そのretained reservationに期待するscalar reserved units / budget identityを含みます。authoritativeなretained stateと一致しない場合、実装はfail closedします。budget **limitはhistorical identityではありません**。既存のsame-key mutable-limit contractを維持するため、reconciliationはbudget keyを比較し、過去のlimit値の一致は要求しません。

| Result | 意味 | application側の安全な扱い |
| --- | --- | --- |
| `absent` | **現在** retained stateが見つからない | 自動replay禁止。Store retention horizonを過ぎた可能性があれば「過去に存在しなかった」証明にはなりません。 |
| `active / pending` | matching reservationがあり、liability未確定 | application側でもbusiness work未開始を別途証明でき、trusted lease bindingを保持している場合だけreattach候補。reconciliation自体はreplay許可ではありません。 |
| `active / liable` | matching cost-liable reservationがある | business side effectを再実行しない。既に始まったworkのapplication固有recoveryでrenew/settleする用途。 |
| `expired / pending` | retained pending leaseの期限超過 | この結果からmetered workを開始しない。通常のStore recoveryが後でcapacityをreleaseできます。 |
| `expired / liable` | retained liable leaseが期限超過、またはliable-expiredとして保守的にrecovery済み | replay禁止。capacityはStore contractどおり保守的に扱います。 |
| `settled` | matching terminal settlement/tombstoneをretainedしている | terminal。execution replayは許可されません。 |

### Indeterminate / unknown

`indeterminate` は成功status variantとしては返しません。backend/transport failure、unsupported mode、corrupt state、binding mismatchなどで上記statusを証明できない場合、reconciliationはreject/throwし、callerは **indeterminateとしてfail closed** します。

これによりinfrastructure failureを`absent`やallowへ変換しません。

## Read-only invariant

reconciliationは次を行ってはいけません。

- capacityの新規reserve
- pending capacityのrelease
- liability確定
- lease renew
- settlement
- replay stateの作成・書換え

同じretained stateに対するreconciliationを繰り返してもaccounting stateは変化しません。writeするのは通常lifecycle methodと通常Store cleanup/recoveryだけです。

## Reattachment boundary

`active / pending` は `UsageControl.resumeLease()` に必要なauthoritative reservation recordを提供できます。ただしapplication側はtrustedな `ttlMs` も保持/再構成し、business side effectが別経路ですでに始まっていないことを独立に確認する必要があります。

`active / liable` はusage accounting上、execution開始済みの可能性を示します。既開始workのapplication固有recoveryには使えますが、business operation再実行の許可にはなりません。

operation ID / reservation IDはcorrelation・replay identityであり、credentialやauthorization artifactではありません。

## Built-in Store support

| Store | scalar reconciliation | vector initial-reserve reconciliation | Mechanism / boundary |
| --- | --- | --- | --- |
| `MemoryUsageStore` | **Supported** | **Supported** | retained in-process stateをread-onlyで確認します。process restart後の`absent`はhistorical proofではありません。 |
| `RedisUsageStore` | **Supported** | **Supported** | Redis `TIME` / `HGET` / `ZSCORE`を使うread-only Lua pathで、expected scalar/vector topologyを検証します。 |
| `FirestoreUsageStore` | **Supported** | **Supported** | read-only Firestore transactionでexpected scalar/vector topologyを検証します。expiry判定には既存のbounded/synchronized host-clock要件が継続適用されます。 |
| Cloudflare Durable Objects | **Supported** | **Not supported; fail closed** | authenticated read-only scalar lookup gatewayを使用します。vector initial-reserve ACK ambiguityはv0.13ではfail closedです。 |

base `UsageStore` / `VectorUsageStore` にreconciliationを必須化しないため、third-party Storeはsource-compatibleです。optional capabilityを実装しないStoreはambiguous ACKをfail closedのまま扱い、より狭いrecovery boundaryを明記する必要があります。

## Vector reserve reconciliation (v0.13)

`VectorOperationReconciliationStore` はambiguousな **initial vector reserve** acknowledgement向けのread-only contractです。callerはtrusted operation identityに加え、expected dimension key、reserved units、budget-key topologyを正確に渡します。不一致はreject / fail closedし、reconciliation自体はquotaをreserve/releaseしません。

`MemoryUsageStore`、`RedisUsageStore`、`FirestoreUsageStore` が対応します。scalar lookupはvector stateを、vector lookupはscalar stateを別modeとしてrejectし、coerceしません。growth / settlementは既存のexact replay fenceを維持します。

Cloudflare Durable Objectsはv0.13の明示的例外です。remote reconciliation subpathはscalar initial-reserve statusのみをproofし、vector reserve ACK ambiguityはfail closedです。scalar対応からvector対応を推論したり、vector reserveをblind replayしてはいけません。provider-wide vector reconciliation parityを将来claimする場合は、この例外を解消するか明示的に再評価します。

## Portable conformance

`OperationReconciliationStore` 実装は次を利用できます。

```ts
import {
  assertOperationReconciliationStoreConformance,
  runOperationReconciliationStoreConformance,
} from 'mcp-usage-control/conformance';
```

portable suiteはretained `absent -> pending -> liable -> settled`、expired-pendingのread-only観測、quote shape mismatchのfail-closeを検証します。provider固有のdurability、transport ambiguity、clock、failover evidenceはportable conformanceとは別に必要です。

## Non-goals

operation reconciliationは次ではありません。

- business-result cache
- workflow replay
- payment/billing ledger lookup
- authorization
- automatic retry middleware
- Store固有settlement/growth idempotencyの代替

usage Storeが証明するのはusage-enforcement stateだけです。business sideのidempotency / recoveryはapplication責務のままです。

## v0.13 vector reserve reconciliation 追補

v0.13ではread-onlyな `VectorOperationReconciliationStore` を追加します。callerはtrustedなoperation identityと、期待するdimension key / reserved units / budget-key topologyを渡し、retained stateと一致しない場合はfail closedします。`MemoryUsageStore` / `RedisUsageStore` / `FirestoreUsageStore` が対応します。scalar lookupはvector stateを、vector lookupはscalar stateをmode変換せずrejectします。

Cloudflare Durable Objectsはv0.13では明示的な例外です。authenticated remote reconciliation subpathが証明するのはscalar initial reserveのみで、vector reserve ACK ambiguityは引き続きfail closedです。scalar supportからvector supportを推測したり、ambiguous vector reserveをblind replayしてはいけません。
