# Observability

[English](observability.md) | [日本語](observability.ja.md)

`mcp-usage-control` はprovider-neutralなstructured lifecycle eventを提供します。observabilityは意図的に **enforcement transactionの外側** に置きます。observerはlog、metric、trace、外部転送に使えますが、quotaのsource of truthにはしません。

## Observerを設定

runtime lifecycle eventとstore-level expiry recovery eventの両方が必要なら、`UsageControl` とstoreへ同じobserverを渡します。

```ts
import {
  UsageControl,
  type UsageEvent,
  type UsageObserver,
} from 'mcp-usage-control';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const observer: UsageObserver = {
  onEvent(event: UsageEvent) {
    console.log(JSON.stringify(event));
  },
};

const store = new RedisUsageStore(redis, { observer });
const control = new UsageControl(store, policy, {
  observer,
  metadata: {
    service: 'my-mcp-server',
    environment: 'staging',
  },
});
```

`metadata` は明示的なopt-in dataです。usage requestを受け取るcallback形式にもできます。secret、token、raw tool arguments、無制限なuser contentはmetadataへ入れないでください。

従来のnumber形式の第3constructor引数も引き続き利用できます。

```ts
new UsageControl(store, policy, 60_000);
```

## Event type

### `reserve.accepted`

storeが適用budgetをatomicにreserveした後に発火します。

request identity、`reservationId`、`budgetKeys`、`reservedUnits`、`remainingByBudget`を含みます。

### `reserve.denied`

policy denial、quota denial、duplicate-operation denialで発火します。

quota denialでは `limitingBudgetKey` / `remaining` を含む場合があります。

### `settlement.completed`

store settlement成功後に発火します。idempotent settlement replayも含みます。

reserved / actual / released unitsとsettlement outcomeを含みます。

### `reservation.recovered`

expired leaseをrecoveryしたときに発火します。

- `pending_released`: cost-liableになる前なのでcapacityを解放。
- `liable_retained`: execution開始済みなのでfull reservationを保守的に維持。

Memory reference storeは、もともと保持しているlocal reservation / request identifierをeventへ出せます。一方Redis storeはtelemetryのためだけにraw principal、tenant、tool、budget stringを永続化しません。そのためRedisのlazy cleanupでは `count` と合計 `reservedUnits` を持つaggregate recovery eventを出します。expired Redis reservationを直接操作した場合はopaqueなhashed reservation IDを含む場合があります。

### `operation.error`

policy quoteまたはstore reserve / mark-liable / renew / settleがthrowした場合に発火します。

error class/nameだけを含み、raw exception messageは意図的に含めません。exception messageにはcredential、内部URL、query text、provider response bodyなどが入る可能性があるためです。

## Delivery semantics

observer deliveryは次の性質です。

- best-effort
- non-blocking
- concurrent call間の順序保証なし
- runtimeによるretryなし
- durableではない
- admission / settlement結果を変更しない

observerの同期throwとasync promise rejectionは握りつぶします。durable analyticsやbilling reconciliationが必要なら、application側でdurable queue / ledgerへ送信し、そのpipelineを別途monitorしてください。

usage storeがenforcement truthです。

## Privacy / cardinality

Tool argumentsは自動でeventへコピーしません。raw exception messageもコピーしません。

runtime eventには `principalId`、`tenantId`、`operationId`、`reservationId`、tool名、budget keyが含まれる場合があります。これらはpotentially sensitiveかつhigh-cardinalityなfieldとして扱ってください。

推奨:

- structured log / trace: privacy policy上許容される場合のみIDを利用。
- metric: tool、outcome、plan、error classなどbounded dimensionを利用。
- **unique principal / operation / reservation / user-specific budget IDをmetric label/tagにしない。**

Prometheus、Cloud Monitoring、Datadog、OpenTelemetry metrics backend等でのcardinality explosionを避けるためです。

## 作りやすいcounter

このevent streamから、例えば次のbounded counterを作れます。

- tool / plan別accepted call数
- reason / tool / plan別denied call数
- tool / outcome別consumed units
- released units
- pending-expiry recovery件数
- liable-expiry retained units
- phase / error class別store/state error

ただし、これらのcounterをtransactional quota balanceとして使わないでください。enforcement eventから作る運用ビューです。

## Vendor adapter

core runtimeはOpenTelemetry、OpenMeter、Datadog、Cloud Monitoring、GA4、billing providerへ依存しません。必要な連携はapplication codeまたは将来のoptional adapterで追加します。

関連: [Architecture](architecture.ja.md)、[API reference](api-reference.ja.md)、[Redis adapter](redis.ja.md)、[Security policy](../SECURITY.ja.md)。
