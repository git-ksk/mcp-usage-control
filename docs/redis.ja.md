# Redis adapter

[English](redis.md) | [日本語](redis.ja.md)

`@mcp-usage-control/redis` は `mcp-usage-control` の最初のproduction-store adapterです。

現在のpre-alpha implementationはCIでRedis 7とNode.js 20 / 22を使ってtestしています。node-redisが公開している `eval(script, { keys, arguments })` interfaceを利用し、workspaceでは現在 `redis` 6.2.xを対象にしています。

## Atomicity model

admissionを `GET -> compare -> SET` のように分割しません。Redis-side Luaがstate transitionをatomicに実行します。

1. target budgetに属するexpired reservationをbounded batchで回収する。
2. expired idempotency tombstoneをbounded batchでcleanする。
3. duplicate principal / operation IDを拒否する。
4. current usageとbudget limitを比較する。
5. unitsをreserveし、pending leaseを作成する。

`markLiable`、renewal、settlementもそれぞれatomic Lua transitionです。同一settlement replayはidempotent、conflicting replayは拒否します。

## Pendingとcost-liable expiry

新規reservationは `pending` です。cost-liableへ遷移する前にexpireした場合、Redisはreserved unitsを解放しoperation recordを削除します。

`markLiable()` 成功後のexpiryは保守的に扱います。Redisはfull reserved unitsを消費済みとして維持し、recordを `lease_expired_after_execution_started` outcomeのsettled stateへ変換し、通常のtombstone mechanismでreplay protectionを維持します。

これによりmetered execution boundaryへ入った後のprocess crashが自動refundになることを防ぎます。一方、generic MCP adapterではhandler entry直後・実provider cost発生前にprocessが消えた場合にover-accountする可能性があります。これは安全側の既定値です。

## Redis server time

lease作成、renewal、expiry check、tombstone expiryはLua script内で取得したRedis server timeを利用します。adapterはこれらのtransitionにapplication側 `Date.now()` を使いません。

そのため複数application instance間のclock skewや、requestがRedis実行前にnetwork上で長く待った場合でも、expiry判定がapplication hostの時計に左右されません。

## Redis Cluster hash slot

すべてのtransactional keyは、意図的に1つのconfigurable hash tagを共有します。defaultではkeyに `{usage}` が含まれます。

これによりreserve / mark-liable / renew / settle scriptをRedis Cluster上でもatomicに実行でき、将来のmulti-budget transactionでも `CROSSSLOT` を避けられます。一方で、現在の設計ではusage-control writeが1つのRedis Cluster slotへ集中するtrade-offがあります。

correctnessを既定で優先します。将来複数usage-control shardを導入する場合でも、1つのatomic admissionに参加するbudgetは同一transaction domainに置く必要があります。

## Key model

raw principal ID、operation ID、budget keyをRedis key nameへ直接埋め込みません。principal IDとoperation IDは曖昧性のないtupleへencodeした後にSHA-256 hash化し、budget keyは別にhash化します。

conceptual stateは次のとおりです。

```text
<prefix>:{<hashTag>}:budget:<budgetHash>:used
<prefix>:{<hashTag>}:budget:<budgetHash>:pending
<prefix>:{<hashTag>}:reservations
<prefix>:{<hashTag>}:operations
<prefix>:{<hashTag>}:tombstones
```

reservation recordにはhashed operation identifier、unit count、lease expiry、state、settlement outcomeを保持します。`outcome` はlow-cardinalityかつnon-sensitiveな値にしてください。

## Lease heartbeatとpartition

MCP adapterはsingle-round tool handler実行中、active leaseを既定でrenewします。core / Redisを直接使うapplicationは長時間reservationを自分でrenewしてください。

network partitionがdistributed leaseより長く続く可能性は残ります。Redis unavailable中、adapter callはstorage errorをpropagateし、新規admissionをallowへfail openしません。generic heartbeatは任意のupstream resourceをfenceしません。ただしexecution-started leaseはcost-liableなので、expiry時にはrefundせず保守的にchargeします。

## Idempotency tombstone

settled operation IDは `idempotencyTtlMs` の間replay protectionを維持します。defaultは24時間です。cleanupはlazyかつbatch-limitedなので、新規admissionがなければexpired stateがより長く残る場合があります。

これは安全側の挙動です。stale stateはoperation IDの再利用を遅らせることがありますが、追加quotaを許可する方向には働きません。

## Lazy cleanup backlog

`cleanupBatchSize` は1回のadmissionで行うexpiry / tombstone cleanup量を制限します。1つのbudgetに1 batchを超えるexpired reservationが溜まると、stale reserved unitsが残り、一時的に保守的なquota denialが発生する場合があります。

これはavailability trade-offでありquota bypassではありません。crash / expiry量が非常に多いoperatorは `cleanupBatchSize` を適切に調整し、stale-state pressureをmonitorしてください。将来はatomic admissionを弱めずにdedicated maintenance / reconciliationを追加する余地があります。

## Budget key lifecycle

adapterはbudget windowのreset時刻を推測しません。policy側でwindow-qualified keyを使用してください。

```text
month:user-123:2026-08
day:user-123:2026-08-10
```

budget keyを変更すると新しいaccounting windowになります。古い `used` keyへadapterが自動TTLを付与しないのは、誤ったretentionによるaccounting corruptionを避けるためです。多数のhistorical windowを持つoperatorは、自身のbudget-key schemeに合ったretention policyを適用してください。

## Atomicityとdurabilityは別

Lua scriptはRedis内部でatomicなstate transitionを提供します。ただし、それだけでacknowledged writeがあらゆるprocess crash、host failure、failover、persistence設定下で必ず残ることを保証するわけではありません。

production enforcementではapplicationが許容できるaccounting state lossに合わせてRedis persistence / HAを選定してください。少なくとも次を確認します。

- persistenceが有効か。
- RDB / AOF policyと許容loss window。
- replication / failover behavior。
- backup / recovery手順。
- 利用するRedis serviceがfailover時にacknowledged writeを失う可能性。

より強いdurable financial ledgerが必要なら、Redis usage stateをenforcement layerとして扱い、別のdurable ledger / event systemへreconcileしてください。Lua atomicityだけからfinancial-grade durabilityを推論してはいけません。

## Failure behavior

Redis errorはusage allowへ変換しません。reserveやmark-liable writeはclientがACKを受け取れなくても適用済みの可能性があります。同一logical invocationを同じoperation IDでretryすればduplicate protectionが二重reserveを防ぎ、mark-liableの曖昧性もexpiry時には保守的に扱われます。

settlementも同様にwrite後のACK lossを想定し、同一settlement replayをidempotentにしています。異なるactual units / outcomeでのreplayはconflictとして拒否します。

CIでは実Redisに対して100並列reserve、pending expiry recovery、liable crash recovery、renewal、settlement replay/conflict、tombstone expiry、write後のlost acknowledgement、application clock非依存をtestします。

## Configuration

- `prefix`: usage-control keyのprefix。Redis hash-tag braceは指定できません。
- `hashTag`: transactional keyを同じRedis Cluster slotへ置くためのhash tag。
- `cleanupBatchSize`: 1回のreserveで回収するexpired reservation / tombstone数の上限。
- `idempotencyTtlMs`: settled operation IDをreplay protectionする期間。

同じlogical usage domainに参加するprocessはcompatibleなprefix / hashTag設定を利用してください。設定が分裂すると別accounting stateとして扱われます。

## Current limits

- 1 reservationにつき1 budget。atomic multi-budget admissionは別途追跡中です。
- settlementは `actualUnits <= reservedUnits` が必要です。
- cleanupはadmissionごとのlazy / bounded方式です。
- Redis durability policyはdeployment-specificで、adapter自体は強制しません。
- billing、payment、authentication、analytics backendは内蔵しません。