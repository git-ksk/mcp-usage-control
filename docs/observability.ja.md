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

`metadata` は明示的なopt-in dataです。usage requestを受け取るcallback形式にもできます。secret、token、raw tool arguments、provider payload、無制限なuser contentはmetadataへ入れないでください。

policy denialの `reason` もapplication定義で、`reserve.denied` へコピーされます。free-form diagnostic textではなく、boundedかつnon-secretなreason codeとして扱ってください。

従来のnumber形式の第3constructor引数も引き続き利用できます。

```ts
new UsageControl(store, policy, 60_000);
```

## 安全なstructured log projection

raw `UsageEvent` はtraceや制御された診断には便利ですが、意図的にhigh-cardinalityなidentity fieldを含みます。運用logやlog-based metricでは `projectUsageEvent()` を使い、より安全でboundedなshapeへ落としてから出力できます。

```ts
import {
  projectUsageEvent,
  type UsageObserver,
} from 'mcp-usage-control';

const observer: UsageObserver = {
  onEvent(event) {
    const record = projectUsageEvent(event);
    console.log(JSON.stringify(record));
  },
};
```

default projectionには `eventType`、`phase`、`result`、boundedな `denialReason` / `errorClass`、reserved / actual / released units、recovery count、remaining budgetのaggregate情報（`budgetCount`、`remainingMin`、`remainingMax`）だけを残します。raw principal / tenant / operation / reservation ID、tool名、budget key、settlement `outcome`、application定義のdenial textは意図的に除外します。

projected JSONの例:

```json
{
  "timestamp": 1786411200000,
  "eventType": "reserve.accepted",
  "phase": "reserve",
  "result": "success",
  "reservedUnits": 2,
  "budgetCount": 2,
  "remainingMin": 8,
  "remainingMax": 98
}
```

明示metadataを含めたい場合だけopt-inします。

```ts
const record = projectUsageEvent(event, { includeMetadata: true });
```

既存のmetadata trust modelはそのまま適用されます。secretでなく、key/valueともboundedだとapplication側で保証できるmetadataだけopt-inしてください。

log-based metricのdimensionには `eventType`、`phase`、`result`、`denialReason`、`errorClass`、`store`、`recovery` などを使えます。units / remaining系は値として記録し、tool名、budget key、各種ID、任意metadataを自動的にlabelへ昇格させないでください。

raw settlement `outcome` とapplication提供のpolicy denial `reason` はdefault projectionへ入れません。application側でmetricに追加する場合は、有限個のallow-list codeへ正規化してからdimensionにしてください。free-form文字列を単にtruncateするだけではcardinality対策として不十分です。

## Event type

### `reserve.accepted`

storeが適用budgetをatomicにreserveした後に発火します。

request identity、`reservationId`、`budgetKeys`、`reservedUnits`、`remainingByBudget`を含みます。

### `reserve.denied`

policy denial、quota denial、duplicate-operation denialで発火します。

quota denialでは `limitingBudgetKey` / `remaining` を含む場合があります。

### `settlement.completed`

store settlement成功後に発火します。同一内容のidempotent settlement replayでも再発火する場合があります。

reserved / actual / released unitsとsettlement outcomeを含みます。

### `reservation.recovered`

expired leaseをrecoveryしたときに発火します。

- `pending_released`: cost-liableになる前なのでcapacityを解放。
- `liable_retained`: execution開始済みなのでfull reservationを保守的に維持。

Memory reference storeは、もともと保持しているlocal reservation / request identifierをeventへ出せます。一方Redis storeはtelemetryのためだけにraw principal、tenant、tool、budget stringを永続化しません。そのためRedisのlazy cleanupでは `count` と合計 `reservedUnits` を持つaggregate recovery eventを出します。これらの運用aggregateはoverflowさせず `Number.MAX_SAFE_INTEGER` でsaturateします。このsaturationはtelemetryだけに適用し、quota / accounting stateは丸めません。expired Redis reservationを直接操作した場合はopaqueなhashed reservation IDを含む場合があります。

### `operation.error`

policy quoteまたはstore reserve / mark-liable / renew / settleがthrowした場合に発火します。

boundedなconstructor class名だけを含みます。raw exception messageやmutableな `Error.name` は、credential、内部URL、query text、provider response body、無制限なhigh-cardinality textを含む可能性があるため意図的に含めません。

## Delivery semantics

observer deliveryは次の性質です。

- best-effort
- enforcement outcomeの外側
- `onEvent()` がPromiseを返してもawaitしない
- concurrent call間の順序保証なし
- runtimeによるretryなし
- durableではない
- admission / settlement結果を変更しない

`onEvent()` 自体はinlineで呼ばれます。同期処理は軽量にし、network call、durable write、重いserializationはapplication側のqueue / telemetry pipelineへoffloadしてください。返されたPromiseはawaitしません。observerの同期throwとasync promise rejectionは握りつぶします。

durable analyticsやbilling reconciliationが必要なら、application側でdurable queue / ledgerへ送信し、そのpipelineを別途monitorしてください。usage storeがenforcement truthです。

## Replay / deduplication

observabilityはexactly-onceではなく、**同じ意味のeventが再度届く可能性があります**。例えばRedisのidentical settlement replayはenforcement state上idempotentですが、`settle()` をもう一度呼ぶと同一内容の `settlement.completed` が再発火する場合があります。

downstream counterやdurable pipelineで二重計上を避ける必要がある場合は、例えば次のstable keyでsettlement eventをdedupeしてください。

```text
(reservationId, actualUnits, outcome)
```

dedupe horizonは対象pipelineのretry / reconciliation horizon以上にします。event件数からquota truthを推測せず、enforcement stateまたはdurable accounting stateをquery / reconcileしてください。

## Privacy / cardinality

Tool argumentsは自動でeventへコピーしません。raw exception messageもコピーしません。

runtime eventには `principalId`、`tenantId`、`operationId`、`reservationId`、tool名、budget keyが含まれる場合があります。これらはpotentially sensitiveかつhigh-cardinalityなfieldとして扱ってください。

推奨:

- structured log / trace: privacy policy上許容される場合のみIDを利用。
- operational log / log-based metric: `projectUsageEvent()` を優先。
- metric: projected event type、phase、result、denial reason、recovery type、error classなどbounded dimensionを利用。
- **unique principal / operation / reservation / tool / user-specific budget IDをmetric label/tagにしない。**

Prometheus、Cloud Monitoring、Datadog、OpenTelemetry metrics backend等でのcardinality explosionを避けるためです。

## 作りやすいcounter

raw event streamまたはsafe projectionから、例えば次のbounded operational counterを作れます。

- accepted call数
- bounded denial reason別denied call数
- consumed / released units
- pending-expiry recovery件数
- liable-expiry retained units
- phase / error class別store/state error

必要に応じてreplay deduplicationを適用してください。これらのcounterをtransactional quota balanceとして使わないでください。enforcement eventから作る運用ビューです。

## Cloudflare recovery telemetry

`CloudflareUsageStore` / `RemoteCloudflareUsageStore` は `store: 'cloudflare'` の `reservation.recovered` を発火できます。lazy cleanupはaggregate count / units、直接指定されたexpiryではopaque hashed reservation IDだけを含められます。recovery telemetryのためだけにraw principal / tenant / tool / operation / budget / tool-argument値をCloudflare backendへ永続化しません。

## Vendor adapter

core runtimeはOpenTelemetry、OpenMeter、Datadog、Cloud Monitoring、GA4、billing providerへ依存しません。必要な連携はapplication codeまたは将来のoptional adapterで追加します。

関連: [Architecture](architecture.ja.md)、[API reference](api-reference.ja.md)、[Redis adapter](redis.ja.md)、[Security policy](../SECURITY.ja.md)。
