# Store実装contract

[English](store-contract.md) | [日本語](store-contract.ja.md)

この文書はthird-party Store向けのnormative compatibility boundaryです。

同じTypeScript method名を実装しただけでは、production-safe compatibleとは言えません。Storeはenforcement transactionそのものに参加するため、concurrency、retry、expiry、process loss、ACK ambiguityでも同じfailure semanticsを守る必要があります。

対象は2種類です。

1. `UsageStore` — quota reservation、liability、renewal、settlement、expiry recovery
2. `McpUsageFlowStore` — MCP multi-round resume用のtrusted one-time compare-and-consume state

## Compatibility level

### Behaviorally compatible

portable conformance kitを通過し、以下のpublic method semanticsを満たすStoreを **behaviorally compatible** と呼びます。

これは通常系とconcurrent state-machine behaviorの互換性を示します。persistence、failover、authoritative time、network ACK ambiguityまで証明するものではありません。

### Production-safe for a stated deployment model

次の両方が揃った場合だけ、**特定deployment modelに対してproduction-safe** と表現します。

- portable behavioral conformance kitに合格
- この文書にあるdurability / failure requirementについてimplementation-specific evidenceがある

「完全にdurable」のような文脈なしの表現は使いません。Redisのpersistence / HA、Firestoreのhost-clock assumption、Durable Objectのdurabilityなどはdeployment propertyであり、明記が必要です。

happy-pathだけ動くStoreをproduction-safeとは扱いません。

## `UsageStore` transaction contract

budget-window semanticsは全implementationでapplication-ownedです。Storeは同一の `budget.key` を同じauthoritative accounting bucketとして扱い、wall-clock timeが進んだだけでdaily / monthly resetを作ったりnon-zero budget stateを破棄したりしてはいけません。historical windowを安全にretireできるかは、application-specific Store contractで明示しない限りapplication lifecycle decisionです。

```ts
interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult>;

  markLiable(input: MarkLiableInput): Promise<MarkLiableResult>;
  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}
```

### 1. Atomic admission

`reserve()` は参加する **全budget** とlogical-operation replay recordを1つのatomic state transitionとして扱います。

admitする場合は同じindivisible decisionの中で次を実施します。

- 全budgetが `units` を受け入れられるか確認
- 全budgetへ同じ `units` をreserve
- active reservationを作成
- `(tenantId, principal.id, tool, operationId)` のlogical operation identityをclaim

どれか1つでもdenyなら、どのbudgetも部分的に変更せず、operation identityもadmittedとしてclaimしてはいけません。

`read counters -> decide -> 各counterを別々にwrite` のようなsplit implementationは、sequential testが通ってもcompatibleではありません。

### 2. Concurrency

overlapするbudgetへのconcurrent `reserve()` はstoreのauthoritative transaction boundaryでserialize / coordinateし、limitをoversubscribeしてはいけません。

同じenforcement domainを共有する全process / instance間でcorrectnessが必要です。process-local mutexだけではhorizontal scaleで安全になりません。

### Mutable effective limit

`budget.key` がauthoritative accounting bucketを識別し、`budget.limit` は **current admission attemptに渡されたeffective policy ceiling** として扱います。compatibleなStoreはlimitを固定bucket definitionとしてpersistし、後から正当にlimitが変わったときに既存usageをreset / replace / reinterpretする実装にしてはいけません。

同じ `budget.key` では:

- supplied limitを上げても既存reserved / consumed usageを維持し、増えたheadroomだけを新たに使えるようにする
- supplied limitを下げても既存usageを維持し、authoritative usageがlower limit以上ならnew admissionをdenyする
- limit changeで既存pending / liable reservationをcancel / shrink / refund / re-price / re-admitしない
- settlementは通常どおりactual usageを保持し、unused reserved capacityだけをreleaseする
- plan / override変更だけを理由にkeyを変えない。key変更はapplicationが本当に新しいaccounting bucket / windowを意味する場合だけ行う

各admissionは概念的に次を評価します。

```text
remaining = max(0, suppliedEffectiveLimit - authoritativeUsedOrReserved)
```

Storeが提供するのはatomic accountingであり、distributed policy-version consensusではありません。同じkeyについてconcurrent application instanceが異なるlimitを渡した場合、それぞれのreserve attemptはそのcallerのsupplied limitとその時点のauthoritative usageで評価されます。そのためstaleなhigher limit callerが、すでにstricter limitを使うcallerならdenyするworkをadmitできることがあります。strict downgrade cutoverが必要なapplicationはeffective-policy rolloutをStore外でcoordinateする必要があります。

upgrade / downgrade / trial / override / rollout例は [Mutable quota limit](mutable-quota-limits.ja.md) を参照してください。

### 3. Logical-operation replay identity

duplicate protectionのscopeはexact tupleです。

```text
(tenantId, principal.id, tool, operationId)
```

ambiguousなdelimiter連結でkeyを作らず、unambiguous encodingまたはそのcollision-resistant digestを使います。

別tenant・別toolで同じ `operationId` は別operationです。`operationId` はidempotency inputでありauthenticationではありません。

### 4. Reservation record

accepted `reserve()` はadmitted request / budgetsへbindingされたreservationを返します。`reservationId` はauthoritative reservationを一意に指す必要がありますが、その値をclientが持つだけでauthorityになってはいけません。

backend key/queryに使うexternally supplied reservation IDはformat validationするべきです。

### 5. `pending -> cost-liable`

reservationは `pending` で始まり、metered costが発生し得るwork直前の `markLiable()` でcost-liableになります。

同じactive liable reservationへの `markLiable()` replayはidempotentでなければなりません。

expired pendingを `markLiable()` 中にfresh active reservationへ復活させてはいけません。

### 6. Lease renewal

`renew()` はactive pending / liable reservationだけを延長します。expired / missing / settled reservationを再作成してはいけません。

`expiresAt` はauthoritative store decisionを表し、time authorityを明示します。

- distributed storeでserver/store timeを使えるならそれを優先
- host clockならskew assumptionとexpiry graceを明記
- client入力をauthoritative current timeに使わない

### 7. Pending expiry

active `pending` がexpireしたら:

- 全budgetからreserved unitsをatomically release
- active logical-operation claimを解放し、recovery後は再admission可能にする
- budgetごとのpartial releaseを残さない

recoveryはeager / lazy / scheduledのどれでも構いませんが、cleanupの途中状態でcapacityをovercount / undercountしてはいけません。

### 8. Cost-liable expiry

`liable` reservationがauthoritative settlement前にexpireしたら:

- optimisticにreserved unitsをreleaseしない
- full reservationをconsumedとして保守的に保持
- configured idempotency period中duplicate protectionを保持
- `lease_expired_after_execution_started` 等のinternal outcomeによるfull settlement相当として扱う

execution開始後のprocess lossをautomatic refundにしてはいけません。

### 9. Settlement

`settle()` はactive reservationのterminal transitionです。

必須semantics:

- `0 <= actualUnits <= reservedUnits`
- `reservedUnits - actualUnits` を全budgetからatomically release
- `actualUnits` はconsumedとして保持
- bounded tombstone / replay recordを保持
- tombstone保持中のidentical replayは同じsettlementを返す
- `actualUnits` または `outcome` が違うreplayはreject

`actualUnits > reservedUnits` のようなinvalid attemptは、正当なactive reservationをcorrupt / terminal化してはいけません。

### 10. ACK ambiguity

storeがcommitした後にtransport/processがresponseを失う場合があります。

- **reserve ACK lost** — 同じlogical identityでのretryが2個目のreservationを作らない。read-only reconciliationを提供してもよい
- **markLiable ACK lost** — safe transitionを確認できないままmetered workへ入らない。commit済みなら後でconservative retentionされ得る
- **renew ACK lost** — extension成功を前提にしない
- **settle ACK lost** — tombstone idempotencyがあればidentical settlementのみreplay可。conflicting settlementはfail

unknown state-changing outcomeへautomatic retry middlewareを足す場合は、このcontract上のidempotencyをproofできる場合に限ります。

### 11. Backend failureはfail closed

admission中のbackend errorを `{ accepted: true }` やpolicy allowへ変換してはいけません。

cleanup / recovery failureはcapacityを保守的に多くreserveしたままにすることは許容できますが、追加admission capacityを作ってはいけません。

unexpected / corrupt stored stateはempty/new stateとして扱わずexplicit errorでfail closedします。

### 12. Durability / failover

Atomicityとdurabilityは別です。

production deploymentはauthoritative backendについて次を明記します。

- acknowledged write loss
- replica failover
- transaction中restart
- application instanceとのpartition
- success response後のcommitted state loss

acknowledged reservationを失い、その後conflicting workをadmitできるdeploymentは、API conformanceを通ってもstrict enforcement用途ではproduction-safeではありません。

### 13. Untrusted input / privacy

policy-controlled budget keyやapplication identityがStore boundaryへ入ります。implementationは:

- backendに必要なlength / range / format validation
- raw concatenationによるquery/key injection回避
- defaultでsecret / tool argsをlogしない
- hashingをencryptionと誤認しない
- observabilityだけのためにraw identityを保存しない

を守ります。

## Portable `UsageStore` conformance kit

framework-independent runnerをexportします。

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';

await assertUsageStoreConformance({
  createStore(scenario) {
    return createMyStore({ namespace: `contract-${scenario}` });
  },
  async waitForLeaseExpiry(ttlMs, scenario) {
    await waitForMyStoreExpiry(ttlMs, scenario);
  },
  async cleanup(scenario) {
    await deleteMyTestNamespace(scenario);
  },
});
```

runnerは少なくとも次をproofします。

- all-or-nothing multi-budget denial
- shared limitでのconcurrent admission
- 既存usageをresetしないlimit increase
- pending / liable / settled usageを維持するlimit decrease
- 同じauthoritative bucketに対するstricter / stale-higher policy viewのconcurrency
- logical-operation replay scope
- idempotent liability transition
- active lease renewal
- identical settlement replay / conflicting settlement rejection
- invalid settlement non-corruption
- pending expiry release
- liable expiryのconservative retention / replay protection

runner合格はproduction-safe claimの **必要条件ですが十分条件ではありません**。backend固有のfault / ACK / durability evidenceが別途必要です。

## `McpUsageFlowStore` compare-and-consume contract

`protectMultiRoundTool()` はone-time resume claim用に別Storeを使います。

```ts
interface McpUsageFlowStore {
  suspend(record: McpUsageFlowRecord): void | Promise<void>;
  consume(
    flowId: string,
    binding: McpUsageFlowBinding,
  ): McpUsageFlowRecord | undefined |
     Promise<McpUsageFlowRecord | undefined>;
}
```

これはgeneric workflow DBではありません。trusted / bounded / one-time resume authorityだけを扱います。

### 必須semantics

- `suspend()` は既存flow IDをoverwriteせずreject
- stored flow stateはserver-side trusted stateでありclient credentialではない
- `consume()` は **principal ID / optional tenant ID / tool / args hash** をatomically compare
- mismatchはrecordを返さず、正当なflowもconsumeしない
- matching consumeはcompareと同じatomic operationでexactly once remove / claim
- concurrent matching consumerはwinner最大1
- expired flowはresume不可
- corrupt / partial stateはmismatchやfresh state扱いせずfail closed
- lost consume ACK後にblind `consume()` retry + business-handler re-entryをしない

horizontal scaleではshared / durable flow storeが必要です。sticky MCP sessionはcompare-and-consume invariantの代替になりません。

## Portable MCP flow-store conformance kit

```ts
import {
  assertMcpUsageFlowStoreConformance,
} from 'mcp-usage-control-mcp/conformance';

await assertMcpUsageFlowStoreConformance({
  createStore(scenario) {
    return createMyFlowStore({ namespace: scenario });
  },
  async waitForFlowExpiry(ttlMs) {
    await sleepPastAuthoritativeExpiry(ttlMs);
  },
});
```

次をproofします。

- one-time matching consume
- principal / tenant / tool / args mismatch preservation
- concurrent one-winner consume
- original flowを壊さないduplicate suspend rejection
- expiry rejection

UsageStoreと同様、backend durabilityとlost-consume-ACK behaviorはportable runner外のimplementation-specific evidenceが必要です。

## Built-in implementation evidence

built-in Storeはportable semanticsとprovider-specific test / documentationを組み合わせます。同じ `UsageStore` conformance runnerをMemoryはunit CI、Redisは通常のRedis-backed test matrix、Cloudflare Durable Objectsはlocal workerd、FirestoreはLocal Emulator Suiteで実行します。

| Store | Atomic primitive | Time model | Production固有のboundary/evidence |
| --- | --- | --- | --- |
| `MemoryUsageStore` | process-local synchronous state | host `Date.now()` | reference implementation。restart lossを許容するcontrolled single-process用途は可。restart-durable / horizontal sharedではない |
| `RedisUsageStore` | 1 Redis Lua transaction domain | Redis `TIME` | portable conformance + concurrency / ACK-loss / expiry / renew / replay test。persistence / HAはdeployment-specific |
| `CloudflareUsageStore` | 1 Durable Object + SQLite transaction domain | Durable Object runtime/store | local workerdでportable conformance + deployed dogfood。remote ambiguityはsurfaceしblind retryしない |
| `FirestoreUsageStore` | Firestore transaction | host clock + documented grace | emulatorでportable conformance + bounded skew / ambiguity evidence。shared-document contentionはdeployment limit |
| `MemoryMcpUsageFlowStore` | process-local compare/delete | host `Date.now()` | reference/single-process専用 |
| `RedisMcpUsageFlowStore` | per-flow Redis Lua compare/delete | Redis expiry/server time | concurrent consume / mismatch preservation / lost-consume-ACK fail-closed test。Redis HAはdeployment-specific |

built-in test合格はunderlying providerをfinancial ledgerへ変えるものではありません。このprojectはusage admissionをenforceし、financial-grade durabilityが必要なら別systemへreconcileします。

## Optional progressive reservation growth contract（v0.6）

third-party Storeはfixed-reservation `UsageStore`のままでよい。Progressive growthは**optional capability**とし、既存Storeのsource compatibilityを維持する。

```ts
interface ProgressiveUsageStore extends UsageStore {
  growReservation(input: GrowReservationInput): Promise<StoreGrowResult>;
}
```

このcapabilityを実装するStoreは`runProgressiveUsageStoreConformance()`にも合格し、production-safeなprogressive growthをclaimする前にbackend-specificなconcurrency / acknowledgement-ambiguity evidenceを持たなければならない。

normative rule:

- Store-issued opaque `growthCursor`付きで作成されたreservationだけgrowable。旧/fixed reservationはreadableだが`grow`はfail closed。
- attemptはapplication-owned stable `incrementId`、`additionalUnits`、current limitを含むoriginal budget set全体、expected cursorを持つ。
- accepted growthは全participating budgetと`reservedUnits`をatomicに増加する。partial growthは禁止。
- authoritative quota denialはcapacityを変更しないが、attempt resultを記録してcursorをrotateする。
- same increment + same prior cursor + same canonical parametersはexact replayし、二重reserveしない。
- same increment identityのconflicting reuse、またはstale cursorでdifferent incrementを送るとreject。
- pendingはpending、liableはliableのまま。growthはTTLをrenewしない。
- expiry/recoveryはgrown total全体へ既存pending/liable ruleを適用する。
- settlementはtotal successfully reserved capacityを超えられない。
- settledまたはexpired/recovered後は、replayを含む全growth callをrejectする。
- Store/provider ambiguityを追加metered workの許可へ変換しない。

process lossから同じlogical operationを復旧する必要がある場合、callerはgrowth送信**前**に同じ`incrementId`を永続化するかdeterministicに再構成できるようにする。cursorはreplay fenceでありauthenticationではない。

詳細は[Progressive reservation growth](progressive-reservation-growth.ja.md)と[MCP progressive example](progressive-mcp-integration.ja.md)を参照。

## Optional atomic vector capability (v0.7)

`VectorUsageStore` はrequests / tokensなど異なるdimensionを1 logical operationで扱うoptional extensionです。scalar `UsageStore` contractは変更しません。

vector Storeは`reserveVector()` / `growVectorReservation()` / recovery / `settleVector()`でrequired dimension全体を1 atomic transaction domainに維持します。異なるunitは加算しません。scalar / vector reservationは同じoperation-idempotency domainを共有します。

vector growthはv0.6 stable increment / cursor contractをvector全体へcomposeします。ACK loss後のexact retryはauthoritative resultをreplayし、quota denialはcapacityを消費せずcursorをrotateし、stale cursor上のfresh incrementはfail closedです。settlementは全dimensionをexactly once報告し、dimensionごとのtotal successfully reserved capacity以内に制限します。

Store compatibilityをclaimする前に`mcp-usage-control/conformance`の`runVectorUsageStoreConformance()`を実行してください。詳細は[Atomic heterogeneous usage vector](vector-usage.ja.md)を参照。

## Optional scalar operation reconciliation contract (v0.8)

`OperationReconciliationStore` は `UsageStore` のoptional read-only extensionです。accounting stateを変更せずretained scalar operation statusを返します。

```ts
interface OperationReconciliationStore extends UsageStore {
  reconcileOperation(input: UsageOperationReconciliationInput): Promise<UsageOperationReconciliation>;
}
```

reconciliation中にcapacity reserve/release、liability確定、renew、settle、replay state書換えを行ってはいけません。trusted logical operation identity、expected retained scalar units、budget identityを検証します。backend/transport failure、corrupt state、unsupported vector state、identity mismatchは`absent`へ変換せずindeterminate / fail closedのまま扱います。

このcapabilityを実装するStoreは `runOperationReconciliationStoreConformance()` / `assertOperationReconciliationStoreConformance()` を実行し、backend固有のlost-ACK / time / durability / failover evidenceも別途必要です。v0.8 portable contractはscalar-onlyで、`VectorUsageStore`へgeneric reconciliation claimを暗黙継承しません。詳細は [Operation reconciliation / status](operation-reconciliation.ja.md)。
