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

| Store | Atomic primitive | Time model | Production固有のboundary/evidence |
| --- | --- | --- | --- |
| `MemoryUsageStore` | process-local synchronous state | host `Date.now()` | reference implementation。restart lossを許容するcontrolled single-process用途は可。restart-durable / horizontal sharedではない |
| `RedisUsageStore` | 1 Redis Lua transaction domain | Redis `TIME` | concurrency / ACK-loss / expiry / renew / replay test。persistence / HAはdeployment-specific |
| `CloudflareUsageStore` | 1 Durable Object + SQLite transaction domain | Durable Object runtime/store | local workerd + deployed dogfood。remote ambiguityはsurfaceしblind retryしない |
| `FirestoreUsageStore` | Firestore transaction | host clock + documented grace | emulator concurrency / atomicity / expiry test。clock skewとshared-document contentionはdeployment limitとして明記 |
| `MemoryMcpUsageFlowStore` | process-local compare/delete | host `Date.now()` | reference/single-process専用 |
| `RedisMcpUsageFlowStore` | per-flow Redis Lua compare/delete | Redis expiry/server time | concurrent consume / mismatch preservation / lost-consume-ACK fail-closed test。Redis HAはdeployment-specific |

built-in test合格はunderlying providerをfinancial ledgerへ変えるものではありません。このprojectはusage admissionをenforceし、financial-grade durabilityが必要なら別systemへreconcileします。
