# Cloudflare platform usage / Free-plan operation

[English](cloudflare-free-plan-usage.md) | [日本語](cloudflare-free-plan-usage.ja.md)

Cloudflare Durable Objects の limit は MCP tool call 数ではなく platform operation に対して適用されます。1回の protected tool invocation は通常、複数の `UsageStore` transition を実行します。remote Cloudflare 構成では各 transition が1回の authenticated gateway request と1回の Durable Object method invocation になります。

Cloudflare の billing / usage counter を quota truth として利用しないでください。enforcement の source of truth は `mcp-usage-control` state です。

## Store operation の形

代表的な remote operation 数は次の通りです。

| Logical path | Usage-store operations | Remote gateway / DO invocations |
| --- | --- | ---: |
| business quota で reserve deny | `reserve` | 1 |
| reserve accept後、metered work前にcancel | `reserve -> settle` | 2 |
| 通常の protected success | `reserve -> markLiable -> settle` | 3 |
| N回 heartbeatするlong-running success | `reserve -> markLiable -> renew × N -> settle` | `3 + N` |
| lost ACK後のidentical settlement reconciliation | 通常path + replay `settle` | reconciliation 1回ごとに +1 |
| application判断によるambiguous reserve retry | 通常path + retry `reserve` | retry 1回ごとに +1 |

authentication / validation failure は Worker gateway で停止するため、Durable Object まで到達しない場合があります。

deployed integration suite は通常の1 tool callより意図的に大きく、100-way contention が大半を占めます。full run は authentication probe を除き、おおむね130回の authenticated store operation を実行します。

## OperationごとのSQLite work

Cloudflare は SQLite activity を rows read / written で扱います。実際に課金・limit対象となる row 数は query result、index、参加 budget 数、そのrequestで実行されたlazy recoveryに依存するため、adapterは「1 call = 固定N rows」のような不正確な定数を定義しません。

capacity estimateに使える実装形は決まっています。1 reservationに参加するbudget数を `B` とします。

### `reserve`

baseline:

- bounded expired-reservation cleanup scan と settled-tombstone delete
- duplicate reservation lookup 1回
- budgetごとのbalance lookup（logical SQL query levelで `B` read）

accept時はさらに:

- budgetごとのupsert（logical SQL statement levelで `B` write）
- reservation insert 1回

quota denyの場合、admission用budget/reservation writeは行いません。ただし、その前にbounded lazy cleanupがrecovery writeを行う場合があります。

### `markLiable`

direct-expiry recovery lookup、reservation state lookup、pendingならreservation state update 1回がbaselineです。

### `renew`

direct-expiry recovery lookup、reservation state lookup、lease expiry update 1回がbaselineです。

したがってheartbeat 1回ごとに remote gateway request、Durable Object invocation、SQLite transaction が1回ずつ追加されます。

### `settle`

direct-expiry recovery lookup と reservation state lookup がbaselineです。初回の正常settlementはreservation tombstoneをupdateします。unused unitをreleaseする場合、参加budgetすべてに対して `B` budget updateも実行します。

identical settlement replayはidempotentなlookup/reconciliation pathであり、quotaを再reserveしません。

### Recovery amplification

lazy recoveryはboundedですが、後続 `reserve` に追加workを発生させます。

- expired pending reservation: 各budgetをupdateしてreserved unitをreleaseし、reservationをdelete
- expired liable reservation: chargeをconservativeに維持し、settled tombstoneへupdate
- expired settled tombstone: bounded delete

crash / abandoned leaseが多いworkloadは、healthy steady-stateよりSQLite operationが増える可能性があります。

## Free-plan運用ガイド

Workers Free は SQLite-backed Durable Objects を利用できます。request / compute / storage / SQLite の最新limitは Cloudflare の Durable Objects pricing documentationを参照し、application enforcementへ永続的な数値前提としてコピーしないでください。

運用では次の順で見積もります。

1. 上の表からprotected-call volumeをstore-operation数へ変換する。
2. long-running toolのheartbeat数を加える。
3. retry / reconciliation と bounded expiry recovery のheadroomを加える。
4. Worker / Durable Object request と SQLite metrics をplatform側で観測する。
5. `UsageObserver` では `reserve.accepted`、`reserve.denied`、`settlement.completed`、`reservation.recovered`、`operation.error` などprovider-neutral lifecycle counterを取る。
6. unique principal / operation / reservation IDをmetric labelへ入れない。

Cloudflare Free-plan limit exhaustionをbusiness quota denialへ変換してはいけません。Cloudflareの現在の仕様では、Free-tier limitを超過した種類のoperationは、該当limitがresetされるまで失敗します。platform unavailabilityとして扱います。

## Platform failure と business quota denial の区別

この2つは意図的に別pathです。

- **Business quota denial:** Durable Objectは正常protocol envelopeとして `accepted: false`, `reason: 'quota_exceeded'` を返します。remote callerは通常の `StoreReserveResult` を受け取り、quota-specific responseを返せます。
- **Cloudflare / Durable Object failure:** gatewayは内部invocation failureをraw runtime exceptionをserializeせずHTTP `503`へ変換します。`RemoteCloudflareUsageStore` はnon-success HTTP statusをcode `remote` の `CloudflareUsageTransportError` に変換し、callerはfail-closeします。errorには `429` / `503` などboundedな数値 `status` だけを保持でき、remote response bodyは公開しません。
- **Network / timeout ambiguity:** remote clientは `network` / `timeout` を返し、blind retryしません。`timeoutMs` は rotating credential/header取得、fetch、response body/protocol decodeまでを含む1 call全体のdeadlineです。

Cloudflare platform failure後に別quota ledgerへdynamic switchしないでください。enforcement truthが分裂し、quota oversubscriptionを許す可能性があります。

## Observability mapping

既存のprovider-neutral eventでboundedな運用viewを作れます。

- `reserve.accepted` / `reserve.denied`: logical admission / denial
- `settlement.completed`: settlement / reconciliation completion
- `reservation.recovered`: Cloudflareのaggregate pending-release / liable-retained recovery
- `operation.error`: phase / bounded error classごとのstore/runtime failure

成功した `markLiable` / `renew` はcore event streamでunique-ID metricとして増やしていません。backend volumeはlifecycleとheartbeat設定から決定的に見積もれ、正確なplatform-call数が必要ならWorker / Durable Object request layerで計測できます。

関連: [Cloudflare adapter](cloudflare.ja.md)、[Observability](observability.ja.md)、[実環境E2E手順](cloudflare-deployed-e2e.ja.md)。
