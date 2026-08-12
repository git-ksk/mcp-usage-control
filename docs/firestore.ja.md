# Firestore UsageStore

[English](firestore.md) | [日本語](firestore.ja.md)

`mcp-usage-control/firestore` は、server-side Firestore transactionを使って `UsageStore` contractを実装するadapterです。

Firebase Admin SDKの `getFirestore()` またはGoogle Cloud Node.js Firestore clientを、structural typeとしてそのまま渡せます。core packageはFirebase / Google Cloud SDK自体へruntime dependencyを持ちません。

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { UsageControl } from 'mcp-usage-control';
import { FirestoreUsageStore } from 'mcp-usage-control/firestore';

const db = getFirestore();
const store = new FirestoreUsageStore(db);
const control = new UsageControl(store, policy);
```

このadapterは **Node.js server/Admin client向け** です。browser / mobile Firestore SDKをquota enforcementのauthoritative storeとして直接使う設計ではありません。

## Atomicity

1 invocationへ複数budgetがある場合、reservation documentと全budget documentを1つのFirestore transactionで読み、quota比較とreserveをall-or-nothingでcommitします。

```text
user daily ----\
user monthly ---+--> one Firestore transaction --> reservation
tenant monthly -/
```

どれか1つでも不足していれば、他budgetだけがpartial reserveされることはありません。

Firestore transactionはconcurrent modification時にretryされ、transaction全体が成功するか失敗するかのどちらかです。store errorをunmetered allowへ変換しないでください。

## Document layout

デフォルトでは2つのtop-level collectionを使います。

```text
muc_budgets/{sha256(budgetKey)}
muc_reservations/fs1.{sha256(operationScope)}
```

`collectionPrefix` で `muc` 部分を変更できます。

raw principal ID、tenant ID、tool name、operation ID、budget keyはdocument bodyへ保存しません。document IDにはSHA-256 digestを使います。ただしhashingはencryptionではなく、推測可能なidentifierに対するdictionary attackを防ぐものではありません。

## 重要: shared budgetのcontention / hotspot

通常のuser budgetはuserごとに別documentになります。

```text
user-a daily -> budget doc A
user-b daily -> budget doc B
user-c daily -> budget doc C
```

この形なら利用者が増えてもwrite先が自然に分散します。

一方、tenant / organization全体の共通budgetは、そのtenantの全userが同じdocumentを更新します。

```text
user-a --\
user-b ----> tenant:company-x:monthly
user-c --/
```

ここは**意図的なserialization point**です。厳密なshared quotaを守るため、同じtenant budgetを使うtransaction同士は同じdocumentで競合します。

Firestoreはtransaction contentionを自動retryしますが、競合が強すぎる場合は最終的に `ABORTED: Too much contention on these documents` で失敗し得ます。Firestoreには「単一documentは常にX writes/secまで安全」という固定値の保証はありません。実際のdocument write rate、transaction participants、index fanout、network latency等を含めてload testしてください。

特に次の場合はRedis / Durable Objects / RDB等も比較してください。

- 1 tenantへ多数userのtool callが継続的に集中する。
- 1 invocationで多数budget documentを同時更新する。
- very low latencyで高頻度なquota admissionが必要。
- shared global budgetがsystem-wide hotspotになる。

Firestore server clientはdatabaseに近いregionから利用してください。距離が大きいほどtransaction lock / retry時間が伸び、contentionの影響を受けやすくなります。

参考:

- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Transaction contention / serializable isolation: https://firebase.google.com/docs/firestore/transaction-data-contention
- Reads/writes at scale: https://firebase.google.com/docs/firestore/understand-reads-writes-scale

## Expiry recovery

Firestoreにはbudget counterとreservationを別documentとして保持するため、pending reservation documentをTTL policyだけで削除してはいけません。documentだけ消すとbudget側のreserved capacityを解放できなくなるためです。

adapterは `expiresAtMs` をqueryできるreservation collectionを持ち、bounded recoveryを実行します。

```ts
const summary = await store.recoverExpired(100);
```

recovery ruleはcore semanticsと同じです。

- pending expiry: 全budgetからreserved unitsを解放し、reservationを削除。
- liable expiry: full reserved unitsを維持し、保守的にsettled化。
- settled tombstone expiry: replay-protection documentだけ削除。確定済みusageはbudgetに残す。

`reserve()` はdefaultで最大16件のcleanupを、同一processでは最低5秒間隔のbest-effortで試みます。cleanup queryが失敗してもreserved capacityが余分に残るだけで、quota capacityを増やすことはないためauthoritative reserve transactionは続行します。

確実な回収時間が必要なproduction環境では、Cloud Scheduler / cron等から `recoverExpired()` を定期実行してください。`cleanupBatchSize: 0` でautomatic cleanupを無効化できますが、その場合は外部schedulerを推奨します。

## Clock semantics

Redis adapterはRedis server `TIME` をlease / tombstoneのauthoritative clockとして使います。

Firestore adapterはtransaction callbackからserver commit timeをlease arithmeticへ直接利用できないため、defaultではapplication hostの `Date.now()` を使います。そのため複数instanceのclock synchronizationが必要です。

defaultで `expiryGraceMs: 5000` を設定し、軽微なclock skewによるpremature recoveryを抑えます。これは正確なserver-time guaranteeの代替ではありません。

productionでは次を守ってください。

- host clockをNTP等で同期する。
- TTLをnetwork latencyや想定clock skewより十分長くする。
- 非常に厳しいlease-time authorityが必要ならRedis server time / Durable Object等を比較する。

## Cost / write amplification

budget数を `N` とすると、概ね次のdocument accessが発生します。

- reserve: reservation + N budgetをreadし、acceptedならreservation + N budgetをwrite。
- markLiable: reservationをtransaction update。
- renew: reservationをtransaction update。
- settle: reservation + N budgetをreadし、unused capacityがあればbudgetを書き戻し、reservationをsettled化。
- recovery: expired reservation + 対象budgetをtransactionで処理。

user daily + user monthly + tenant monthlyのようにbudgetを増やすほど1 invocationあたりのtransaction participantも増えます。Firestore billingとlatencyを見積もるときはtool call数だけでなく、このwrite amplificationを含めてください。

## Security / operations

- enforcement用Firestoreはtrusted server credentialからだけ更新する。
- clientがbudget / reservation collectionを直接変更できるSecurity Rulesにしない。
- Firestore / Firebase Admin credential failureをallowへfallbackしない。
- `quota_exceeded` とFirestore availability/contention failureを区別する。
- hash化document IDをsecretとして扱わない。
- high-cardinalityなraw identity / budget keyをmetric labelへ出さない。

Firestoreは小〜中規模のserverless MCP backend、とくに**user単位budgetが中心**の構成では扱いやすい選択肢です。巨大tenant共有budgetやglobal budgetが支配的な構成では、共有documentがhotspotになることを前提にload testしてください。
