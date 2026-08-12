# Firestoreを利用状況の保存先にする

[English](firestore.md) | [日本語](firestore.ja.md)

`mcp-usage-control-firestore` は、Firestoreを利用上限の判定とreservation管理に使うためのStore実装です。

Firebase Admin SDKやGoogle CloudのNode.js Firestore clientを、そのまま渡して使えます。

## まず結論

Firestoreが向いているのは、次のような構成です。

- すでにFirebase / GCPを使っている
- 利用上限の中心が「ユーザーごと」になっている
- Redisなど別の常駐サービスを増やしたくない
- serverless構成との相性を重視したい

一方で、次のような構成では事前に負荷試験をおすすめします。

- 1つのtenant全体で共有するquotaへ大量のtool callが集中する
- system全体で1つのglobal quotaを共有する
- 非常に低いlatencyで大量のadmissionを処理したい

理由は単純で、**同じbudget keyは同じFirestore documentを更新する**からです。

共有範囲が大きいほど、その1documentへ更新が集中しやすくなります。

## 最小構成

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { UsageControl } from 'mcp-usage-control';
import { FirestoreUsageStore } from 'mcp-usage-control-firestore';

const db = getFirestore();
const store = new FirestoreUsageStore(db);
const control = new UsageControl(store, policy);
```

このadapterは**server-side専用**です。

browserやmobileのFirestore SDKから、利用上限の元データを直接更新する使い方は想定していません。

利用上限を最終的に判定するStoreなので、信頼できるserver credentialからだけ更新してください。

## Firebase SDKはruntime dependencyに含めていない

`mcp-usage-control-firestore` 自体はFirebase Admin SDKやGoogle Cloud SDKをruntime dependencyに持ちません。

application側ですでに使っているserver Firestore clientを、必要なmethodだけを持つstructural interfaceとして受け取ります。

そのためFirebase AdminでもGoogle Cloud clientでも利用できます。

## Firestoreに保存するもの

defaultでは2つのtop-level collectionを使います。

```text
muc_budgets/{sha256(budgetKey)}
muc_reservations/fs1.{sha256(operationScope)}
```

`collectionPrefix` を指定すると `muc` の部分を変更できます。

役割は次のとおりです。

- `muc_budgets` — そのbudgetで現在どれだけ利用済み・予約済みかを管理
- `muc_reservations` — 1つのlogical operationに対応するlease状態を管理

principal ID、tenant ID、tool名、operation ID、budget keyそのものはdocument bodyへ保存しません。

document IDにはSHA-256 digestを使います。

ただし、**hash化は暗号化ではありません**。hash化したdocument IDをsecretとして扱わないでください。

## 一番大事なのはbudget keyの決め方

Firestore adapterは、「これはuser budget」「これはtenant budget」と自動判定しません。

applicationが渡す `budget.key` が同じなら、同じbudgetとして扱います。

### ユーザーごとに分ける場合

```text
user:a:daily:2026-08-12 -> document A
user:b:daily:2026-08-12 -> document B
user:c:daily:2026-08-12 -> document C
```

各ユーザーが別documentを更新するので、書き込み先が自然に分散します。

### tenant全体で共有する場合

```text
tenant:company-x:monthly:2026-08
```

company-xの全ユーザーがこのkeyを使うと、全requestが同じdocumentを更新します。

```text
user-a --\
user-b ----> company-xの共有budget document
user-c --/
```

これは不具合ではありません。

**tenant全体の厳密な上限を守るには、全員が同じ値を見て更新する必要があるためです。**

その代わり、利用が集中すると同じdocumentへの更新競合が増えます。

## 複数のbudgetもまとめて判定する

1回のtool callで、たとえば次の3つを同時に守れます。

- user daily
- user monthly
- tenant monthly

Firestoreではこれらを1つのtransactionで処理します。

```text
user daily ----\
user monthly ---+--> 1つのFirestore transaction --> reservation
tenant monthly -/
```

どれか1つでも上限に達していれば、他のbudgetだけを部分的に予約することはありません。

**全部成功するか、全部失敗するか**です。

Firestore側で同時更新がぶつかった場合はSDKがtransactionをretryします。

最終的に完了できなければStore errorとして失敗します。

Store errorを「上限を確認できなかったから今回は通す」という扱いにしないでください。

## 共有budgetにアクセスが集中するとどうなる？

同じdocumentを複数transactionが同時に更新すると、Firestore内部で競合が発生します。

Firestoreは自動でretryしますが、競合が強すぎると最終的に次のようなerrorになることがあります。

```text
ABORTED: Too much contention on these documents
```

Firestoreには「1documentなら必ず毎秒X回まで安全」という一律の保証値はありません。

実際の性能は、次のような条件に左右されます。

- 同時transaction数
- 1transactionに参加するdocument数
- network latency
- indexの負荷
- database regionとの距離

そのため、大きなtenant共有quotaやglobal quotaを使う場合は、本番に近いtrafficで負荷試験してください。

特に次の構成ならRedis / Durable Objects / RDBも比較する価値があります。

- 1tenantへ大量のtool callが継続的に集中する
- 1callで多数のbudgetを更新する
- 低latencyを強く求める
- system全体で1つのglobal budgetを使う

Firestore clientはdatabaseに近いregionから使う方が、transaction retryの影響を抑えやすくなります。

## 期限切れreservationの回収

pendingのreservationをFirestore TTLだけで削除してはいけません。

reservation documentだけ消すと、budget側に残っている予約済みcapacityを戻せなくなるためです。

adapterは `recoverExpired()` で、budgetとreservationをまとめて安全に回収します。

```ts
const summary = await store.recoverExpired(100);
```

状態ごとの扱いは次のとおりです。

| 状態 | 期限切れ時の扱い |
| --- | --- |
| `pending` | 予約したunitをbudgetへ戻し、reservationを削除 |
| `liable` | 実コストが発生した可能性があるため、予約量をそのまま確定扱いにする |
| `settled` tombstone | replay protection用documentだけ削除。確定済みusageはbudget側に残す |

`reserve()` も自動cleanupをbest-effortで試します。

defaultでは、1回に最大16件を対象にし、同じprocess内では少なくとも5秒間隔を空けます。

このcleanupが失敗しても、余分なquotaが増える方向には倒れません。古いreservationが残って利用可能capacityが少なく見えるだけなので、authoritativeなreserve transaction自体は続行します。

期限切れreservationを一定時間以内に確実に処理したい場合は、Cloud Schedulerやcronなどから `recoverExpired()` を定期実行してください。

`cleanupBatchSize: 0` で自動cleanupを無効化できます。その場合は外部schedulerの利用を推奨します。

## 時刻の扱い

Firestore adapterのlease計算には、application hostの `Date.now()` を使います。

Redis adapterのように、Store側のserver timeを直接使う方式ではありません。

そのためdefaultでは `expiryGraceMs: 5000` を設定し、わずかなclockずれで早すぎるrecoveryが起こりにくいようにしています。

本番では次を守ってください。

- host clockをNTPなどで同期する
- lease TTLをnetwork latencyや想定clock skewより十分長くする
- 厳密なserver-time基準が必要ならRedisやDurable Objectsも比較する

## 1回のtool callで何回Firestoreへ触る？

budget数を `N` とすると、おおよそ次のaccessが発生します。

- reserve — reservation + N budgetをreadし、成功時はreservation + N budgetをwrite
- `markLiable()` — reservationを更新
- `renew()` — reservationを更新
- settle — reservationを確認し、余ったcapacityを返す場合はbudgetも更新
- recovery — 期限切れreservationと必要なbudgetをtransactionで処理

user daily + user monthly + tenant monthlyのようにbudget数を増やすほど、Firestoreのread/write数とlatencyも増えます。

一方、通常の `markLiable()` / `renew()` ではshared budget documentを触りません。

長時間toolのheartbeatがtenant共有budgetの競合を増やさないようにしています。

## セキュリティ上の注意

- Firestore adapterは信頼できるserver credentialからだけ使う
- clientがbudget / reservation collectionを直接変更できるSecurity Rulesにしない
- principal / tenantは認証済みのserver-side contextから決める
- Firestore障害時にunmetered allowへfallbackしない
- `quota_exceeded` とFirestore availability / contention errorを区別する
- hash化document IDをsecretとして扱わない
- user IDやbudget keyのような高cardinality値をmetric labelへ大量に出さない

## Store選びの目安

| 構成 | 候補 |
| --- | --- |
| Firebase / GCPで、ユーザー単位の利用上限が中心 | **Firestoreが使いやすい** |
| 高頻度のtenant共有quota | Redisも比較する |
| Cloudflare中心 | Durable Objectsも比較する |
| test / local development | Memory |

Firestoreを選ぶ場合でも、共有budgetが重要な要件なら本番trafficに近い負荷試験をおすすめします。

## 参考

- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Transaction contention / serializable isolation: https://firebase.google.com/docs/firestore/transaction-data-contention
- Reads/writes at scale: https://firebase.google.com/docs/firestore/understand-reads-writes-scale

API optionは [API reference](api-reference.ja.md)、全体のstate machineは [Architecture](architecture.ja.md) を参照してください。
