# Firestore UsageStore

[English](firestore.md) | [日本語](firestore.ja.md)

`mcp-usage-control-firestore` は、server-side Firestore transactionを使う `UsageStore` adapterです。

## 先に結論

Firestoreは次の構成なら使いやすいです。

- すでにFirebase / GCPを使っている。
- quotaの中心がuser単位で、userごとに別budget keyを使う。
- serverless構成で、Redisなど別のstateful serviceを増やしたくない。

一方、次の構成では事前にload testしてください。

- 1 tenant全体で共有する厳密なquotaへ大量のcallが集中する。
- system-wide global quotaを1つのbudgetで管理する。
- とても低いlatencyで高頻度のadmissionが必要。

理由は、**同じbudget keyは同じFirestore documentになる**からです。大きなshared budgetでは、そのdocumentがtransaction contentionの中心になります。

## 最小構成

Firebase Admin SDKの `getFirestore()` またはGoogle Cloud Node.js Firestore clientをそのまま渡せます。

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { UsageControl } from 'mcp-usage-control';
import { FirestoreUsageStore } from 'mcp-usage-control-firestore';

const db = getFirestore();
const store = new FirestoreUsageStore(db);
const control = new UsageControl(store, policy);
```

このadapterは**trusted server / Admin client向け**です。browser / mobile Firestore SDKをauthoritative quota storeとして直接使う設計ではありません。

Firebase / Google Cloud SDKはadapterのruntime dependencyには含めていません。application側が使っているserver Firestore clientをstructural interface経由で受け取ります。

## Firestoreに何を保存する？

defaultでは2 collectionを使います。

```text
muc_budgets/{sha256(budgetKey)}
muc_reservations/fs1.{sha256(operationScope)}
```

`collectionPrefix` で `muc` を変更できます。

budget documentは現在のreserved/settled usageを保持し、reservation documentは1 logical operationのlease状態を保持します。

raw principal ID、tenant ID、tool name、operation ID、budget keyはdocument bodyへ保存しません。document IDにはSHA-256 digestを使います。

ただしhashはencryptionではありません。hash化document IDをsecretとして扱わないでください。

## 一番大事: budget keyが共有範囲を決める

Firestore adapterは「これはuser budget」「これはtenant budget」と自動判定しません。

**applicationが渡した `budget.key` が同じなら、同じbudget documentを共有します。**

### userごとに分ける例

```text
user:a:daily:2026-08-12 -> document A
user:b:daily:2026-08-12 -> document B
user:c:daily:2026-08-12 -> document C
```

この形ならwrite先がuserごとに分散します。

### tenant全体で共有する例

```text
tenant:company-x:monthly:2026-08
```

company-xの全userがこの同じkeyを使えば、全callが同じbudget documentを更新します。

```text
user-a --\
user-b ----> shared tenant budget document
user-c --/
```

これはバグではなく、**厳密なshared quotaを守るためのserialization point**です。

## 複数budgetも1 transactionで守る

1 invocationがuser daily + user monthly + tenant monthlyを使う場合、reservation documentと全budget documentを1つのFirestore transactionで処理します。

```text
user daily ----\
user monthly ---+--> one Firestore transaction --> reservation
tenant monthly -/
```

どれか1つでもquota不足なら、他budgetだけがpartial reserveされることはありません。

Firestore側でtransaction conflictが起きた場合はSDKがretryします。最終的にtransactionが完了できなければstore errorとして失敗します。

**store errorを「quota判定できなかったのでallow」へfallbackしないでください。**

## Shared budgetで何が起きる？

同じdocumentを複数transactionが同時に更新するとcontentionが発生します。

Firestoreは自動retryしますが、競合が強すぎると最終的に次のようなerrorになることがあります。

```text
ABORTED: Too much contention on these documents
```

Firestoreには「単一documentなら必ずX writes/secまで安全」という一律の保証値はありません。実際のtransaction数、参加document数、network latency、index負荷などで変わります。

そのためshared tenant/global budgetを使う場合は、想定trafficでload testしてください。

特に次ならRedis / Durable Objects / RDBも比較する価値があります。

- 1 tenantへ多数userのtool callが継続的に集中する。
- 1 invocationが多数budgetを同時更新する。
- very low latencyが必要。
- 1つのglobal budgetがsystem全体のhotspotになる。

Firestore clientはdatabaseに近いregionから使う方が安全です。latencyが大きいほどtransaction retryの影響も大きくなります。

## Reservation expiryはどう回収する？

pending reservationをFirestore TTLだけで削除してはいけません。

理由は、reservation documentだけ消すとbudget側に残ったreserved capacityを解放できないからです。

adapterは `recoverExpired()` でtransactionalに回収します。

```ts
const summary = await store.recoverExpired(100);
```

状態ごとの扱いは次です。

| 状態 | expire時の扱い |
| --- | --- |
| `pending` | budgetからreserved unitsを解放し、reservationを削除 |
| `liable` | full reserved unitsを維持し、保守的にsettled化 |
| `settled` tombstone | replay-protection documentだけ削除 |

`reserve()` もdefaultではsmall bounded cleanupをbest-effortで実行します。

確実な回収時間が必要ならCloud Scheduler / cron等から `recoverExpired()` を定期実行してください。

`cleanupBatchSize: 0` でautomatic cleanupを無効化できます。その場合は外部schedulerを推奨します。

## Clockについて

Firestore adapterのlease計算はapplication hostの `Date.now()` を使います。

Redis adapterのようにserver `TIME` をauthoritative clockとして使う構成ではありません。

そのためdefaultで `expiryGraceMs: 5000` を持ち、軽いclock skewで早すぎるrecoveryが起きにくいようにしています。

productionでは:

- host clockをNTP等で同期する。
- TTLをnetwork latencyや想定clock skewより十分長くする。
- 厳密なserver-time authorityが必要ならRedis / Durable Objectsも比較する。

## 1 callあたりのFirestore access

budget数を `N` とすると概ね:

- reserve: reservation + N budgetをread。acceptedならreservation + N budgetをwrite。
- `markLiable()`: reservationのみ更新。
- `renew()`: reservationのみ更新。
- settle: reservationをreadし、unused capacityを返す場合は対象budgetもread/write。
- recovery: expired reservationと必要なbudgetをtransactionで処理。

user daily + user monthly + tenant monthlyのようにbudgetを増やすほど、Firestore billingとlatencyも増えます。

`markLiable()` / `renew()` の通常pathではshared budgetを読まないため、heartbeatがtenant budgetの不要なcontentionを増やさないようにしています。

## Security checklist

- Firestore adapterはtrusted server credentialからだけ使う。
- clientからbudget / reservation collectionを直接変更できるRulesにしない。
- principal / tenantはtrusted auth contextから決める。
- Firestore failureをunmetered allowへfallbackしない。
- `quota_exceeded` とFirestore availability/contention errorを区別する。
- hash化IDをsecretとして扱わない。
- raw user ID / budget keyをmetric labelへ出しすぎない。

## どのstoreを選ぶべき？

| 構成 | 候補 |
| --- | --- |
| Firebase / GCPでuser単位quota中心 | **Firestoreが扱いやすい** |
| 高頻度のtenant/shared quota | Redisを比較 |
| Cloudflare中心 | Durable Objectsを比較 |
| test / local | Memory |

Firestoreを選ぶ場合でも、shared budgetが重要なら本番trafficに近いload testを推奨します。

## 参考

- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Transaction contention / serializable isolation: https://firebase.google.com/docs/firestore/transaction-data-contention
- Reads/writes at scale: https://firebase.google.com/docs/firestore/understand-reads-writes-scale

API optionsは [API reference](api-reference.ja.md)、全体のstate machineは [Architecture](architecture.ja.md) を参照してください。
