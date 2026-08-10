# Redis adapter

[English](redis.md) | [日本語](redis.ja.md)

`@mcp-usage-control/redis` は `mcp-usage-control` の最初のproduction-store adapterです。

現在のpre-alpha implementationはCIでRedis 7とNode.js 20 / 22を使ってtestしています。node-redisが公開している `eval(script, { keys, arguments })` interfaceを利用し、workspaceでは現在 `redis` 6.2.xを対象にしています。

## Atomicity model

admissionを `GET -> compare -> SET` のように分割しません。Lua scriptが次の処理を1つのRedis transaction boundaryとして実行します。

1. target budgetに属するexpired pending reservationをbounded batchで回収する。
2. expired idempotency tombstoneをbounded batchでcleanする。
3. duplicate principal / operation IDを拒否する。
4. current usageとbudget limitを比較する。
5. unitsをreserveし、pending leaseを作成する。

renewalとsettlementもそれぞれatomic Lua transitionです。同一settlement replayはidempotent、conflicting replayは拒否します。

## Redis Cluster hash slot

すべてのtransactional keyは、意図的に1つのconfigurable hash tagを共有します。defaultではkeyに `{usage}` が含まれます。

これによりreserve / renew / settle scriptをRedis Cluster上でもatomicに実行でき、将来のmulti-budget transactionでも `CROSSSLOT` を避けられます。一方で、v0.1ではusage-control writeが1つのRedis Cluster slotへ集中するtrade-offがあります。

既定ではcorrectnessを優先します。将来複数usage-control shardを導入する場合でも、1つのatomic admissionに参加するbudgetは同一transaction domainに置く必要があります。

## Key model

raw principal ID、operation ID、budget keyをRedis key nameへ直接埋め込みません。adapterがprocess内でSHA-256 identifierへ変換してからRedisを呼び出します。

conceptual stateは次のとおりです。

```text
<prefix>:{<hashTag>}:budget:<budgetHash>:used
<prefix>:{<hashTag>}:budget:<budgetHash>:pending
<prefix>:{<hashTag>}:reservations
<prefix>:{<hashTag>}:operations
<prefix>:{<hashTag>}:tombstones
```

reservation recordにはhashed operation identifier、unit count、lease expiry、state、settlement outcomeを保持します。`outcome` はlow-cardinalityかつnon-sensitiveな値にしてください。

## Lease expiryとheartbeat

expired pending reservationは、後続のadmission時にlazy reclaimします。accounting side effectをRedis key-expiry notificationへ依存させないためです。

MCP adapterはtool handler実行中、active leaseを既定でrenewします。core / Redisを直接使うapplicationは、長時間reservationを自分でrenewしてください。

network partitionがdistributed leaseより長く続く可能性は残ります。Redis unavailable中、adapter callはstorage errorをpropagateし、allowへfail openしません。distributed leaseの制約は [Architecture](architecture.ja.md) を参照してください。

## Idempotency tombstone

settled operation IDは `idempotencyTtlMs` の間replay protectionを維持します。defaultは24時間です。cleanupはlazyかつbatch-limitedなので、新規admissionがなければexpired stateがより長く残る場合があります。

これは安全側の挙動です。stale stateはoperation IDの再利用を遅らせることがありますが、追加quotaを許可する方向には働きません。

## Budget key lifecycle

adapterはbudget windowのreset時刻を推測しません。policy側でwindow-qualified keyを使用してください。

```text
month:user-123:2026-08
day:user-123:2026-08-10
```

budget keyを変更すると新しいaccounting windowになります。古い `used` keyへadapterが自動TTLを付与しないのは、誤ったretentionによるaccounting corruptionを避けるためです。多数のhistorical windowを持つoperatorは、自身のbudget-key schemeに合ったretention policyを適用してください。

## Configuration

代表的なoptionは次のとおりです。

- `prefix`: usage-control keyのprefix。Redis hash-tag braceは指定できません。
- `hashTag`: transactional keyを同じRedis Cluster slotへ置くためのhash tag。
- `cleanupBatchSize`: 1回のreserveで回収するexpired reservation / tombstone数の上限。
- `idempotencyTtlMs`: settled operation IDをreplay protectionする期間。

prefix / hashTagを変更する場合は、同じlogical usage domainのprocessが同一設定を利用するようにしてください。設定が分裂すると別accounting domainとして扱われます。

## Failure behavior

Redis errorはusage allowへ変換しません。特にreserve responseがlostした場合、write自体が適用済みの可能性があります。同じoperation IDでretryするとduplicate protectionにより二重reserveを防ぎます。

settlementも同様に、write後のACK lossを想定して同一settlement replayをidempotentにしています。異なるactual units / outcomeでのreplayはconflictとして拒否します。

CIでは実Redisに対して、100並列reserve、expiry recovery、renewal、settlement replay、conflicting replay、tombstone expiry、write後のambiguous acknowledgementをtestしています。

## Current limits

- 1 reservationにつき1 budget。atomic multi-budget admissionは別途追跡中です。
- settlementは `actualUnits <= reservedUnits` が必要です。
- cleanupはadmissionごとのlazy / bounded方式です。
- billing、payment、authentication、analytics backendは内蔵しません。