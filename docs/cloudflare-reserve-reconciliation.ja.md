# Cloudflare reserve ACK reconciliation

`RemoteCloudflareUsageStore` は、失敗した `reserve()` を自動retryしません。timeout / network failureでは、Durable Objectへのreserveがcommit済みなのにACKだけ失われた可能性があるためです。

optional reconciliation APIは、このambiguous case向けの **read-only lookup** を提供します。lookup自体はquotaをreserve / renew / release / settleしません。

v0.8ではこのresult vocabularyをcore `UsageOperationReconciliation` と共有し、generic entry pointを `reconcileRemoteCloudflareOperation()` とします。従来の `reconcileRemoteCloudflareReserve()` はv0.7互換aliasとして引き続きexportします。

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

reconcile対象のtrusted logical operation identity、期待するcurrent retained scalar units、budget identityを保持してください。initial reserve lost-ACK recoveryでは元reserve inputがそのまま該当します。`network` / `timeout` などambiguousな `CloudflareUsageTransportError` の後に明示的にreconcileします。

```ts
import { reconcileRemoteCloudflareOperation } from 'mcp-usage-control-cloudflare/reconciliation';

const result = await reconcileRemoteCloudflareOperation(
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

## canonicalなlost-ACK flow

安全なconsumer sequenceは次です。

```text
reserveを1回だけ実行
  -> ACK付き成功: 通常どおり続行
  -> 明確なbusiness denial: 通常どおり停止
  -> network/timeoutでambiguous: lookupを1回実行
       -> active/pending: 同じreservationへreattachし、1回だけ続行
       -> active/liable: 再実行禁止。既に開始したworkをrecover
       -> settled: 再実行禁止
       -> expired/absent: applicationのrecovery horizonに従ってfail-close
       -> lookup transport/protocol failure: fail-close
```

`active/pending` の具体的なrecoveryでは `UsageControl.resumeLease()` を使えます。policyや `reserve()` を2回目に呼ぶ必要はありません。

```ts
import { UsageControl } from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from 'mcp-usage-control-cloudflare';
import { reconcileRemoteCloudflareOperation } from 'mcp-usage-control-cloudflare/reconciliation';

const remoteOptions = {
  endpoint: process.env.MCP_USAGE_CLOUDFLARE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_TOKEN!}`,
  }),
};
const store = new RemoteCloudflareUsageStore(remoteOptions);
const control = new UsageControl(store, policy);

const reserveInput = {
  request,
  units,
  budgets,
  ttlMs,
};

try {
  const reserved = await store.reserve(reserveInput);
  // ACKを受け取れた通常のStoreReserveResultを処理する。
  void reserved;
} catch (error) {
  const ambiguous =
    error instanceof CloudflareUsageTransportError &&
    (error.code === 'network' || error.code === 'timeout');
  if (!ambiguous) throw error;

  const reconciled = await reconcileRemoteCloudflareOperation(remoteOptions, reserveInput);

  if (reconciled.status === 'active' && reconciled.state === 'pending') {
    const lease = control.resumeLease({
      reservation: reconciled.reservation,
      ttlMs: reserveInput.ttlMs,
    });

    // application側でも「workが別経路で未開始」を先に確認する。
    await lease.markLiable();
    // business workをexactly onceで実行
    await lease.settle(actualUnits, boundedOutcomeCode);
  } else if (reconciled.status === 'active' && reconciled.state === 'liable') {
    // business operationを絶対に再実行しない。
    // 既に開始済みのworkをreconcileし、必要ならrenew/settleだけ行う。
  } else {
    // settled / expired / absentは再実行の許可を意味しない。
    throw new Error('reserve reconciliation did not prove a safe pending continuation');
  }
}
```

すべてのreconciliation stateを暗黙に「reserve成功」へ変換するhelperは意図的に避けます。ambiguityを隠すとbusiness side effectの二重実行を起こしやすくなるためです。

business `duplicate_operation` responseはlost ACKとは別物です。これはlogical operation keyが既に保護されていることを示す明確なstore resultであり、元reserve resultのreplayとして扱ったり、blind retryしたりしないでください。

## Result state

### `active` / `pending`

元reserveがcommit済みでactive、かつ `markLiable` は記録されていません。APIは元request情報をcaller側で使い `ReservationRecord` を復元するため、通常lifecycleへ戻せます。

ただしapplication側でも「business operationが別経路で開始していない」と判断できる場合だけ実行を再開してください。reconciliationが証明するのはreservation stateであり、外部business処理が独立に開始されていないことまでは証明できません。

### `active` / `liable`

reservationが存在し、metered executionは既に開始している可能性があります。operationを再実行しないでください。既に開始したworkに対するapplication固有のrecovery/reconciliationだけを行います。renew / settleが必要なら返されたreservationへserver-sideでreattachできますが、reattachはbusiness side effectの再実行許可ではありません。

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
- `reservedUnits` がcallerのexpected retained scalar unitsと一致する。
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

## Transport behavior

reconciliationは `RemoteCloudflareUsageStore` と同じbounded remote-transport semanticsを使います。1つの `timeoutMs` deadlineがasync header resolution、HTTP fetch、response-body decode、protocol validationまでを覆います。state-changing callの自動retryは行いません。

`CloudflareUsageTransportError` が保持するのはboundedなtransport diagnosticだけです。HTTP responseを受け取った場合はunauthorized / remote / protocol failureの `status` を保持しますが、任意のremote response body、credential、request identity値はerrorへコピーしません。

## 運用ルール

- ambiguousなreserve transport failure後だけreconcileする。
- 元request identity / units / budgetsを完全に同じ値で使う。
- reconciliation前にreserveを自動retryしない。
- `duplicate_operation` とtransport ambiguityを区別する。
- applicationのidempotency / retry horizon内で速やかにreconcileする。
- reconciliationのtransport / protocol failureはfail-closeとして扱う。
- unknown stateをunmetered executionへ変換しない。

local workerd integrationでは、reserve commit後のlost ACKを再現し、並列read-only reconciliation、元quotaが保持されること、`UsageControl.resumeLease()` による復元reservationへのreattach、settlement後のcapacity recoveryまで検証します。
