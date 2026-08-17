# Redis adapter — v0.1

[English](redis.md) | [日本語](redis.ja.md)

`mcp-usage-control-redis` は `mcp-usage-control` のdistributed production-store adapterです。

> **現在の配布状況:** packageはまだnpmへ公開していません。[Source / local tarballから使う](using-from-source.ja.md) に従ってlocal core + Redis tarballをinstallし、`redis@6.2.0` を組み合わせてください。

v0.1はRedis 7、node-redis 6.2.x、Node.js 20 / 22でtestします。

## Atomic multi-budget model

admissionを `GET -> compare -> SET` に分割せず、multi-budgetもclient-side loopにしません。

1つのLua scriptで次を行います。

1. expired leaseをreservation単位でbounded batch回収する。
2. expired settled tombstoneをbounded batchでcleanする。
3. duplicate `(tenant, principal, tool, operation)` identityをrejectする。
4. 参加する全budgetをreadする。
5. 1 budgetでもdenyならwriteせず終了する。
6. 全budgetを許可できる場合だけ、全budgetをincrementして1つのpending reservationをatomicに作る。

`markLiable`、renewal、settlement、expiry recoveryもreservation全体と参加する全budgetに対して処理します。

これによりdaily / monthly / tenant等の複数budgetに参加するoperationでもpartial reserve / partial releaseを防ぎます。

## v0.1 key model

transactional keyはすべて1つのconfigurable Redis Cluster hash tagを共有します。default:

```text
muc:{usage}:used          HASH budgetHash -> used units
muc:{usage}:leases        ZSET reservationId -> active lease expiry
muc:{usage}:reservations  HASH reservationId -> reservation record
muc:{usage}:operations    HASH operationHash -> reservationId
muc:{usage}:tombstones    ZSET operationHash -> settled replay expiry
```

global lease indexを1つ使うため、multi-budget reservationのexpiryを複数budget indexから重複回収する構造になりません。

raw principal / tenant / operation / tool / budget identifierはRedis key nameへ直接埋め込みません。logical operation tupleを曖昧性なくencodeしてSHA-256 hash化し、budget keyも別にhashします。hashingはkey name上のidentifier exposureを減らすものでencryptionではありません。

## Redis Cluster transaction domain

上記keyは同じhash slotへ置き、すべてのLua transitionをRedis Cluster上で `CROSSSLOT` なしに実行できるようにします。

v0.1はhorizontal write distributionよりcorrectnessを優先します。将来複数usage domainへshardする場合でも、1 atomic admissionに参加するbudgetは同じtransaction domainに置く必要があります。

## Pending / cost-liable expiry

reservationは `pending` から開始します。

- `markLiable()` 前にexpire -> **全budget**からreserved unitsを解放し、active operation mappingを削除。recovery後はlogical operationをretry可能。
- `markLiable()` 後にexpire -> 全budgetでfull reserved unitsを維持し、`lease_expired_after_execution_started` でsettled化し、tombstone期間replay protectionを継続。

これによりmetered execution boundaryへ入った後のprocess crashがrefundになりません。

## Redis server time

reserve、`markLiable`、renew、settle時のexpiry check、tombstone expiryはLua内のRedis server `TIME` を使います。これらのenforcement判定にapplication `Date.now()` は使いません。

複数application instanceのclock skewや、application time取得後にnetwork delayが発生してもexpiry accountingを変えません。operational event timestampはtelemetryでありlease判定には使いません。

## Idempotency

logical operation scope:

```text
(tenantId, principal.id, tool, operationId)
```

tupleをhashしてRedis operation keyにします。settled operationは `idempotencyTtlMs` の間replay protectionされ、defaultは24時間です。

identical settlement replayはidempotent、actual units / outcomeが異なるreplayはconflictです。

tombstone cleanupはlazy / boundedです。新規admissionがなければexpired tombstoneが長く残る場合がありますが、operation ID再利用を遅らせる方向であり追加quotaを与えません。

## Lease heartbeat / network partition

MCP adapterはwrapped active leaseをdefaultでrenewします。core / Redisを直接使う場合はlong-running workをapplication側でrenewします。

network partitionがdistributed leaseを超える場合はあります。Redis errorはfail openせずpropagateします。generic heartbeatはupstream-resource fencingではありません。leaseがcost-liableならexpiryは保守的にchargeします。

lease ownershipが不明になった時点で即座にworkを止める必要がある場合はprovider-specific cancellation / fencingを実装してください。

## Recovery observability

optional `UsageObserver` を `RedisUsageStore` へ渡すとexpiry recovery telemetryを受け取れます。admission / settlement / error lifecycle eventも必要なら同じobserverを `UsageControl` にも渡します。

lazy cleanupでは1回のLua executionで複数expired reservationをrecoveryできます。Redis adapterは次を持つaggregate `reservation.recovered` eventとして通知します。

- `recovery: 'pending_released' | 'liable_retained'`
- `count`
- aggregate `reservedUnits`

Redisはcleanup telemetryを詳しくするためだけにraw principal / tenant / tool / budget stringを永続化しません。expired reservationを `renew` / `markLiable` / `settle` で直接触った場合はopaqueなhashed reservation IDをeventへ含む場合があります。

observer deliveryはbest-effortでRedis transactionの外側です。telemetry欠損はrecovery / enforcementが起きなかったことを意味せず、observer failureはRedis stateを変更しません。詳しくは [Observability](observability.ja.md) を参照してください。

## Lazy cleanup backlog

`cleanupBatchSize` は1 admissionあたりのexpired lease / tombstone cleanup量を制限します。stale stateが1 batchを超える場合は一部が次回admissionまで残ります。

v0.1はglobal lease indexなのでcleanup backlogはusage domain全体のcapacity recoveryを保守的に遅らせる可能性があります。availability trade-offでありquota bypassではありません。

crash / abandonment量が多い場合はstale-state pressureをmonitorし `cleanupBatchSize` を調整してください。

## Budget window / retention

adapterはreset dateを推測しません。window-qualified budget keyを使います。

```text
day:user-42:2026-08-10
month:user-42:2026-08
month:tenant-org-7:2026-08
```

keyを変えると新accounting bucketになります。v0.1は `used` budget fieldへ自動TTLを付けません。generic retentionでvalid accounting stateを消すことを避けるためです。削除はapplication自身のwindow lifecycle上safeな場合のみ行ってください。

## Atomicityとdurabilityは別

LuaはRedis内部でatomic transitionを提供しますが、acknowledged writeがすべてのcrash / failover configurationで残ることを意味しません。

production enforcementでは次を明示的に確認してください。

- persistence enabled / disabled。
- AOF / RDB設定と許容loss window。
- replication / failover behavior。
- backup / recovery手順。
- managed Redis serviceのacknowledged-write-loss behavior。

financial-grade durable accountingが必要ならRedisはenforcement layerとして利用し、別のdurable ledger / event streamへreconcileします。

## ACK ambiguity

Redis writeはcommit済みでもclientがACKを失うことがあります。

v0.1の挙動:

- admission ACK loss -> 同logical operationのretryはduplicateとしてblock。別operationはreserved capacityを観測。
- `markLiable` ACK loss -> write済みなら後のexpiryもcost-liableとして保守的charge。
- settlement ACK loss -> identical settlement replayはidempotent、conflicting replayはfail。

CIで実Redisへfault injectionして確認します。

## Configuration

```ts
interface RedisUsageStoreOptions {
  prefix?: string;             // default "muc"
  hashTag?: string;            // default "usage"
  cleanupBatchSize?: number;   // default 256
  idempotencyTtlMs?: number;   // default 86_400_000 (24h)
  observer?: UsageObserver;    // optional best-effort recovery telemetry
}
```

同じlogical usage domainに参加するprocessは同じcompatibleなprefix / hashTag設定を利用してください。observer configurationはRedis transaction identityに参加しません。

## Tested invariants

CIの実Redis 7 test:

- remaining 1 unitへ100 concurrent caller -> exactly 1 admission。
- 1 tenant budgetを共有する100 user -> exactly 1 admission。
- multi-budget denialでpartial reservationなし。
- unused settlementで全budgetをrelease。
- 全budgetに対するpending / liable expiry。
- aggregate pending / liable recovery observabilityとopaque direct-expiry telemetry。
- lease renewal。
- scoped replay protection / tombstone expiry。
- settlement replay / conflict。
- admission / mark-liable / settlementのlost ACK。
- lease判定でapplication clockから独立したRedis server time。
- Redis unavailable -> admission fail closed。

## Current limits

- `actualUnits <= reservedUnits`。
- 1 reservationの全budgetは同じquoted / actual unit countを消費。
- configured usage-control transaction domainにつきRedis hash slot 1つ。
- cleanupはlazy / bounded。
- Redis durability policyはdeployment-specific。
- observabilityはbest-effort / non-durableでquota ledgerではない。
- billing、payment、authentication、analytics backendは内蔵しません。

## Progressive reservation growth（v0.6）

`RedisUsageStore`はoptional progressive-growth contractを実装します。1本の`GROW_SCRIPT` Lua transaction内でactive reservation、original budget-key set完全一致、growth cursor、replay identity、全current budget limitを検証してからaccounting stateを変更します。

- accepted growthは全participating budgetと`reservedUnits`をatomicに増加。
- quota denialはどのcapacityも増加させず、authoritative denied attemptを記録してgrowth cursorだけrotate。
- same `incrementId` + prior cursor + canonical parametersのretryはrecorded resultをreplayし、二重growthしない。
- stale cursorでdifferent incrementを送るとfail closed。
- pending / liable / expiry semanticsは既存reservation ruleをgrown total全体へ適用。
- settlementはtotal successfully reserved capacityを超えない。
- settled / expired reservationはreplayを含めgrowth successを返さない。

Growth metadataは既存reservation JSONへadditiveに`growthCursor`とlatest replay metadataを保存します。v0.5以前が書いたreservationにはgrowth cursorがないため、fixed-reservation contractのままread / settle可能ですがgrowできません。v0.6 upgradeでRedis key migration、balance rewrite、resetは不要です。

実Redis CIではportable progressive Store conformanceとcommitted-growth ACK-loss caseを実行します。ambiguous ACK後はsame stable increment identityだけをretryし、fresh increment発行は禁止です。
