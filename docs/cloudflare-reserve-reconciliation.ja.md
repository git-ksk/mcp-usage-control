# Cloudflare reserve ACK reconciliation

`RemoteCloudflareUsageStore` は、失敗した `reserve()` を自動retryしません。timeout / network failureでは、Durable Objectへのreserveがcommit済みなのにACKだけ失われた可能性があるためです。

optional reconciliation APIは、このambiguous case向けの **read-only lookup** を提供します。lookup自体はquotaをreserve / renew / release / settleしません。

## Gateway設定

reserve reconciliationが必要な場合はbase gatewayの代わりにreconciliable gateway wrapperを使います。

```ts
import { createReconciliableCloudflareUsageStoreGateway } from 'mcp-usage-control-cloudflare/reconciliation';

const usageHandler = createReconciliableCloudflareUsageStoreGateway({
  namespace: env.USAGE_CONTROL,
  domainName: 'production',
  authorize: request =>
    request.headers.get('authorization') === `Bearer ${env.USAGE_GATEWAY_TOKEN}`,
});
```

wrapperは通常の `reserve` / `mark_liable` / `renew` / `settle` を既存gatewayへそのままdelegateし、authenticatedな `lookup` operationだけ追加します。

## Client手順

元のreserve inputをそのまま保持してください。`network` / `timeout` などambiguousな `CloudflareUsageTransportError` の後に明示的にreconcileします。

```ts
import { reconcileRemoteCloudflareReserve } from 'mcp-usage-control-cloudflare/reconciliation';

const result = await reconcileRemoteCloudflareReserve(
  {
    endpoint: process.env.MCP_USAGE_CLOUDFLARE_URL!,
    headers: () => ({
      authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_TOKEN!}`,
    }),
  },
  {
    request: originalRequest,
    units: originalUnits,
    budgets: originalBudgets,
  },
);
```

reconciliationをgeneric retry middlewareとして使わないでください。reserve結果がambiguousになった場合だけ実行する明示的なrecovery stepです。

## Result state

### `active` / `pending`

元reserveがcommit済みでactive、かつ `markLiable` は記録されていません。APIは元request情報をcaller側で使い `ReservationRecord` を復元するため、通常lifecycleへ戻せます。

ただしapplication側でも「business operationが別経路で開始していない」と判断できる場合だけ実行を再開してください。reconciliationが証明するのはreservation stateであり、外部business処理が独立に開始されていないことまでは証明できません。

### `active` / `liable`

reservationが存在し、metered executionは既に開始している可能性があります。operationを再実行しないでください。既に開始したworkに対するapplication固有のrecovery/reconciliationだけを行います。

### `settled`

元reservationはsettlement済みです。operationを再実行しないでください。

### `expired`

元reservationはexpired、またはexpired liable leaseがconservative settlementへ移行済みです。lookupはexpiry recoveryやaccounting state変更を行いません。operationをblindに再実行しないでください。

### `absent`

lookup時点でretained reservation / tombstoneがありません。ただしstate retention / cleanup horizonを過ぎてからのlookupでは、「元reserveが絶対にcommitしていなかった」証明にはなりません。applicationのretry / reconciliation horizonに基づいて保守的に判断してください。

## Identity verification / privacy

clientは元logical operation identityから同じopaque reservation IDを再計算し、元budget keyをcaller側でSHA-256 hash化します。

lookup requestで送信するのはopaqueな `cf1.<sha256>` reservation IDだけです。raw principal ID、tenant ID、tool名、operation ID、budget key、tool argumentsは送信しません。

retained reservationが見つかった場合、clientは次を検証します。

- reservation IDが元operationと一致する。
- `reservedUnits` が元reserve attemptと一致する。
- 保存済みhashed budget identifierが元budget setと完全一致する。

raw request / budget値はcaller側で `ReservationRecord` を復元するためだけに使います。

hashingはencryptionではありません。identifier自体はnon-secretにしてください。

## Concurrency / quota safety

lookupはDurable Object SQLiteへのread-only query 1回です。並列reconciliationを行っても追加unitをreserveせず、既存reservationをreleaseもしません。

通常のstate machineが引き続きauthoritativeです。

```text
reserve -> pending -> liable -> settled
```

accounting stateを変更するのは通常の `reserve` / `markLiable` / `renew` / `settle` / expiry recoveryだけです。

## 運用ルール

- ambiguousなreserve transport failure後だけreconcileする。
- 元request identity / units / budgetsを完全に同じ値で使う。
- reconciliation前にreserveを自動retryしない。
- applicationのidempotency / retry horizon内で速やかにreconcileする。
- reconciliationのtransport / protocol failureはfail-closeとして扱う。
- unknown stateをunmetered executionへ変換しない。

local workerd integrationでは、reserve commit後のlost ACKを再現し、並列read-only reconciliation、元quotaが保持されること、復元reservationからのlifecycle再開、settlement後のcapacity recoveryまで検証します。
