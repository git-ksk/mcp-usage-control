# API reference — current source

[English](api-reference.md) | [日本語](api-reference.ja.md)

このreferenceはcurrent source treeのpublic APIを説明します。5 packageのmanifestは `0.4.0` に揃っています。`v0.4.0` はこのbranchで準備するGitHub/source releaseで、npm registry publicationは引き続き意図的にdeferredしています。

behavior / failure guaranteeは [Architecture](architecture.ja.md) / [Store実装contract](store-contract.ja.md)、v1 stable / deferred境界は [v1.0 readiness review](v1-readiness.ja.md) を参照してください。

## `mcp-usage-control`

### `Principal`

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

applicationが渡すtrusted accounting identityです。authentication primitiveではありません。認証・認可済みのserver-side stateからderiveしてください。

### `UsageRequest<TArgs>`

```ts
interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}
```

replay protectionのscope:

```text
(tenantId, principal.id, tool, operationId)
```

同じlogical invocationのretryでは1つのstable `operationId` を使います。identity proofではなくidempotency inputです。

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

`key` はnon-empty、`limit` はnon-negative safe integerです。daily / monthly windowはapplication policyの責務なので、必要ならwindow identityをkeyへ含めます。

### `UsageQuote` / `UsagePolicy`

```ts
type UsageQuote =
  | {
      decision: 'allow';
      units: number;
      budgets: readonly Budget[];
      reservationTtlMs?: number;
    }
  | {
      decision: 'allow';
      units: number;
      budget: Budget;
      reservationTtlMs?: number;
    }
  | { decision: 'deny'; reason: string };

interface UsagePolicy {
  quote(request: UsageRequest): UsageQuote | Promise<UsageQuote>;
}
```

`budgets` がmulti-budget形式です。全参加budgetへ同じquoted unitsをatomicにreserveします。`budget` は1 budget用convenience formです。empty list / duplicate keyはrejectします。

policy denial reasonはobservabilityへ出る場合があるため、unrestricted diagnostic textではなくbounded non-secret reason codeを推奨します。

### `UsageStore`

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

production実装はatomic admission、replay、liability、renewal、expiry、settlement、fail-closed semanticsを守る必要があります。同じmethod shapeだけではsafe compatibleとは言えません。詳しくは [Store実装contract](store-contract.ja.md)。

### Store側reserve result

accepted resultには次が含まれます。

```ts
{
  accepted: true;
  reservation: ReservationRecord;
  remainingByBudget: Array<{
    key: string;
    remaining: number;
  }>;
}
```

denial reasonは現在 `quota_exceeded` / `duplicate_operation`。`quota_exceeded` はlimiting budget / remaining unitsを持つ場合があります。

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);

new UsageControl(store, policy, {
  defaultReservationTtlMs?: number;
  observer?: UsageObserver;
  metadata?: UsageEventMetadata |
    ((request: UsageRequest) => UsageEventMetadata | undefined);
});
```

default reservation TTLは `60_000` ms。number形式の第3引数もsource-compatibleです。

main method:

```ts
await control.reserve(request)
control.resumeLease(state)
```

`reserve()` はpolicy評価、budget canonicalization、atomic Store admissionを行い `AdmissionResult` を返します。

`resumeLease()` はtrusted server-side `UsageLeaseResumeState` から既存reservationへreattachします。`policy.quote()` / `store.reserve()` は再実行せず、resume後もunderlying Storeがauthoritativeです。

### `AdmissionResult`

```ts
type AdmissionResult =
  | {
      allowed: true;
      lease: UsageLease;
      remainingByBudget: Array<{
        key: string;
        remaining: number;
      }>;
    }
  | {
      allowed: false;
      reason: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };
```

`remainingByBudget` はauthoritative Store resultからcopyされます。consumer側でconfigured limitから再計算しないでください。budget keyはsensitive / high-cardinalityになり得るため、explicit application policyの下でだけ公開します。

### `ReservationRecord`

```ts
interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  budgetKeys: string[];
  reservedUnits: number;
  expiresAt: number;
}
```

### `UsageLeaseResumeState`

```ts
interface UsageLeaseResumeState {
  reservation: ReservationRecord;
  ttlMs: number;
  metadata?: UsageEventMetadata;
}
```

trusted server-sideのresumable accounting stateです。client credential / bearer tokenではありません。raw structureをuntrusted clientへ公開しないでください。

### `UsageLease`

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
lease.toResumeState()
await lease.markLiable()
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

- `markLiable()` — cost-bearing execution boundaryへ入るtransition
- `renew()` — active pending / liable leaseを延長
- `settle()` — terminal transition。`0 <= actualUnits <= reservedUnits`
- `toResumeState()` — trusted server-side resume stateのsnapshot

expired pendingはcapacityをreleaseできます。expired liableでactual usage不明ならfull reserved chargeをconservativeに保持します。

### `SettlementResult`

```ts
interface SettlementResult {
  reservationId: string;
  reservedUnits: number;
  actualUnits: number;
  releasedUnits: number;
  outcome: string;
}
```

tombstone retention中のidentical replayはidempotentです。units / outcomeが異なるconflicting replayはfailします。

### `MemoryUsageStore`

```ts
new MemoryUsageStore({
  idempotencyTtlMs?,
  maxRetainedOperations?,
  maxRetainedBudgetKeys?,
  observer?,
})
```

test / local development / 管理されたsingle-process deployment向けprocess-local reference implementationです。default:

- settled replay retention (`idempotencyTtlMs`): 24時間
- `maxRetainedOperations`: `100_000` active reservation + settled replay tombstone
- `maxRetainedBudgetKeys`: `100_000` distinct non-zero budget key

上限到達時にauthoritative accounting / replay stateをsilent evictionしません。代わりに `MemoryUsageStoreCapacityError` でfail closedします。

運用helper:

```ts
store.stats()
store.retireBudgetKey(budgetKey)
```

`stats()` は現在のretained operation / budget-key数とconfigured limitを返します。`retireBudgetKey()` は終了済みaccounting windowのkeyを明示的に忘れるためのAPIで、active reservationが参照中のkeyはrejectします。application側は、retireしたkeyを同じaccounting windowとして再利用しないことを保証する必要があります。non-zero usageのgeneric automatic TTL / LRU evictionはquota semanticsをresetし得るため意図的に行いません。

expiry / tombstone cleanupはlazyで、store callごとの全件scanではなく最も早い既知deadlineを基準に実行します。ただしprocess-localのままで、horizontal / restart durableなproduction Storeではありません。詳しくは [Memory Storeの長期運用](memory-store.ja.md)。

### `UsageObserver` / `UsageEvent`

```ts
interface UsageObserverHandler {
  onEvent(event: UsageEvent): void | Promise<void>;
}

type UsageObserver = UsageObserverHandler | undefined;
```

current lifecycle event:

- `reserve.accepted`
- `reserve.denied`
- `settlement.completed`
- `reservation.recovered`
- `operation.error`

observer deliveryはbest-effortでenforcement transactionの外側です。返されたPromiseはawaitせず、sync throw / async rejectionもaccounting outcomeを変えません。

`UsageEventMetadata` はexplicit opt-in `Record<string, string | number | boolean | null>` です。

### `projectUsageEvent()`

raw lifecycle eventをlow-cardinalityなoperational shapeへprojectします。defaultではidentity ID、operation / reservation ID、tool / budget identifier、unrestricted settlement outcome、application-defined denial textを除外します。

observabilityでありtransactional ledgerではありません。

### Core errors

- `UsageStateError` — invalid / expired / missing / conflicting Store・resume state
- `UsageDeniedError` — programmatic denial reasonを保持しつつ、thrown messageはgeneric
- `MemoryUsageStoreCapacityError` — boundedなin-memory operation / budget-key retentionが上限に達した状態。accounting stateをevictせず保持し、fail closedする

## `mcp-usage-control/conformance`

`v0.3.0` でpublic conformance subpathを追加しました。

```ts
import {
  runUsageStoreConformance,
  assertUsageStoreConformance,
  UsageStoreConformanceError,
  type UsageStoreConformanceHarness,
  type UsageStoreConformanceReport,
} from 'mcp-usage-control/conformance';
```

portable runnerはmulti-budget atomicity、concurrent admission、replay scope、liability idempotency、renewal、settlement replay / conflict、invalid-settlement non-corruption、pending / liable expiryなどprovider-neutral behaviorを確認します。

合格は **behavioral compatibility** の証明であり、persistence / HA、authoritative time、failover、lost-ACK safetyはbackend固有evidenceが別途必要です。

## `mcp-usage-control-mcp`

### `ProtectToolOptions<TArgs, TResult>`

主要field:

```ts
interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  noInput?: boolean;
  principal(ctx: ServerContext): Principal | Promise<Principal>;
  operationId(args: TArgs, ctx: ServerContext): string | Promise<string>;
  leaseHeartbeat?: boolean;
  successUnits?(...): number | Promise<number>;
  toolErrorUnits?(...): number | Promise<number>;
  errorUnits?(...): number | Promise<number>;
}
```

input schemaなしtoolは `noInput: true` を指定します。

### `protectTool(options, handler)`

single-round MCP TypeScript SDK v2 wrapperです。

- handler前にreserve
- handler entry直前に `markLiable()`
- default heartbeat
- normal success / MCP `{ isError: true }` / throwを別分類
- invalid / throwing classifier -> conservative full settlement後にclassification error
- settlement failure -> blind retryせずsurface
- `input_required` -> このsingle-round wrapperではunsupported。`protectMultiRoundTool()` を利用

### `McpUsageRequestStatePayload`

```ts
interface McpUsageRequestStatePayload {
  mcpUsageControl: 1;
  flowId: string;
}
```

MCP server request-state verification hookがwire valueをverify / decodeした後だけ受け入れます。raw client-controlled stateはfail closedです。

### `McpUsageFlowBinding`

```ts
interface McpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}
```

`argsHash` でcanonicalized validated original argsへresumeをbindingします。

### `McpUsageFlowRecord` / `McpUsageFlowStore`

```ts
interface McpUsageFlowRecord {
  flowId: string;
  binding: McpUsageFlowBinding;
  lease: UsageLeaseResumeState;
  round: number;
  expiresAt: number;
  applicationRequestState?: string;
}

interface McpUsageFlowStore {
  suspend(record: McpUsageFlowRecord): void | Promise<void>;
  consume(
    flowId: string,
    binding: McpUsageFlowBinding,
  ): McpUsageFlowRecord | undefined |
     Promise<McpUsageFlowRecord | undefined>;
}
```

`consume()` はprincipal / tenant / tool / args bindingをatomic compareし、matching flowを1回だけconsumeする必要があります。mismatchで正当なflowを削除してはいけません。

### `MemoryMcpUsageFlowStore`

process-local reference flow store。test / single-process server用です。per-request handler factoryの外で生成してください。

### `McpUsageFlowContext`

```ts
interface McpUsageFlowContext {
  readonly round: number;
  readonly operationId: string;
  readonly applicationRequestState?: string;
}
```

`round` は0開始です。handler-authored application request stateはserver-sideに保持し、次のresume roundでこのcontextから渡します。

### `ProtectMultiRoundToolOptions<TArgs, TResult>`

```ts
interface ProtectMultiRoundToolOptions<TArgs, TResult>
  extends ProtectToolOptions<TArgs, TResult> {
  flowStore: McpUsageFlowStore;
  requestState: {
    mint(
      payload: McpUsageRequestStatePayload,
      ctx: ServerContext,
    ): string | Promise<string>;
  };
  suspendTtlMs: number;
  maxRounds?: number; // default 8
  flowId?: () => string | Promise<string>;
}
```

### `protectMultiRoundTool(options, handler)`

opt-in `input_required` multi-round accounting wrapperです。

- first roundで1回reserveし、application execution前にliable化
- suspension時に `suspendTtlMs` までrenewしtrusted flow stateをserver-side保存
- resumeはverified request state + binding-aware one-time consume必須
- `UsageControl.resumeLease()` で元leaseへ戻り、2回目のquote / reserveをしない
- missing / replay / expired / mismatchはfail closed
- `maxRounds` でrepeated suspensionをbounded化
- final settlementは `protectTool()` と同じconservative classification rule

exactly-once business side effect / completed result replayを提供するgeneric workflow systemではありません。

### MCP adapter errors

- `UsageSettlementError`
- `UsageClassificationError`
- `UnsupportedMcpUsageFlowError`
- `McpUsageResumeError`
- `McpUsageRoundsExceededError`

## `mcp-usage-control-mcp/conformance`

```ts
import {
  runMcpUsageFlowStoreConformance,
  assertMcpUsageFlowStoreConformance,
  McpUsageFlowStoreConformanceError,
  type McpUsageFlowStoreConformanceHarness,
  type McpUsageFlowStoreConformanceReport,
} from 'mcp-usage-control-mcp/conformance';
```

one-time consume、binding mismatch preservation、concurrent one-winner consume、duplicate suspend rejection、expiry rejectionを確認します。

backend durability / lost-consume-ACK behaviorはimplementation-specific evidenceが必要です。

## `mcp-usage-control-redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?)
```

`client` は `RedisEvalClient` compatibleな `eval(script, { keys, arguments })` を提供します。

### `RedisUsageStoreOptions`

```ts
interface RedisUsageStoreOptions {
  prefix?: string;
  hashTag?: string;
  cleanupBatchSize?: number;
  idempotencyTtlMs?: number;
  observer?: UsageObserver;
}
```

Defaults:

- `prefix`: `muc`
- `hashTag`: `usage`
- `cleanupBatchSize`: `256`
- `idempotencyTtlMs`: 24時間

multi-budget admission / lifecycle stateを1 Redis Lua transaction domainで処理し、lease / tombstone timeにはRedis server `TIME` を使います。

### `mcp-usage-control-redis/mcp-flow`

```ts
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';
```

horizontal scaleするMCP multi-round accounting向けshared Redis flow storeです。SHA-256 binding digest compare + matching flow deleteを1 Lua invocationでatomicに行います。1 flowのkeysは同じRedis Cluster hash slotに置き、unrelated flowは別slotへ分散できます。

Redis persistence / HAはdeployment-specificです。

## `mcp-usage-control-cloudflare`

### `CloudflareUsageStore`

1 Durable Object transaction domainを使うWorker-local `UsageStore`。

### `RemoteCloudflareUsageStore`

Cloudflare外application向けHTTP Storeです。local以外はHTTPS必須。optional request headerはstatic / callbackで指定でき、`timeoutMs` はfull remote callをboundedします。

network / timeout / ambiguous remote failureはsurfaceしautomatic retryしません。transport errorへresponse bodyを伝播しません。

### `createCloudflareUsageStoreGateway()`

authenticated Worker gatewayを作ります。application-defined `authorize(request)` がmandatoryで、unauthenticated defaultはありません。

### `mcp-usage-control-cloudflare/worker`

Durable Object implementationをexportし、`UsageControlDurableObject` とdeployment用versioned Worker entry pointを含みます。

### `mcp-usage-control-cloudflare/reconciliation`

supported ambiguous remote reserve outcome向けexplicit read-only reserve-ACK reconciliation helper。reconciliationで追加quotaを作りません。

### `mcp-usage-control-cloudflare/maintenance`

explicitly authorized historical-budget maintenance / pruning helper。routine usage authorityとmaintenance authorityを分離します。

exact deployment API / trust boundaryは [Cloudflare adapter](cloudflare.ja.md) を参照してください。

## `mcp-usage-control-firestore`

### `FirestoreUsageStore`

```ts
new FirestoreUsageStore(firestore, options?)
```

`firestore` はadapter structural contractを満たすserver-side Firestore clientです。

### `FirestoreUsageStoreOptions`

```ts
interface FirestoreUsageStoreOptions {
  collectionPrefix?: string;
  idempotencyTtlMs?: number;
  cleanupBatchSize?: number;
  cleanupIntervalMs?: number;
  expiryGraceMs?: number;
  observer?: FirestoreRecoveryObserver;
  now?: () => number;
}
```

Defaults:

- `collectionPrefix`: `muc`
- `idempotencyTtlMs`: 24時間
- `cleanupBatchSize`: `16`
- `cleanupIntervalMs`: `5_000`
- `expiryGraceMs`: `5_000`

`now` はtest hookです。productionは通常host time + `expiryGraceMs` を使うため、host time synchronizationが必要です。

operation / budget identifierをdocument ID用にhashし、all-or-nothing admissionをFirestore transactionで実行し、pending / liable stateをconservativeにrecoverします。

### `recoverExpired(limit?)`

bounded explicit recoveryを行い `FirestoreRecoverySummary` を返します。設定により `reserve()` もthrottled best-effort cleanupを実行します。

shared tenant / global budget documentはcontention hotspotになり得ます。詳しくは [Firestore adapter](firestore.ja.md)。

## MCP Tasks support boundary

current source treeはstableなfirst-class Tasks protocol adapterをexportしていません。

safe accounting state machineは [MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) に定義し、existing core lease primitiveでproof済みです。upstream TypeScript Tasks surfaceがexperimentalな間、stable protocol integrationはdeferredです。

## Numeric validation

- units / limits: non-negative JavaScript safe integer
- TTL / retention: positive safe integer
- settlement / classifier units: non-negative safe integerかつ `<= reservedUnits`

## Compatibility

- Node.js 20+
- ESM
- MCP TypeScript SDK v2。current conformanceは `2026-07-28` protocol line + SDK 2.0.0 path
- Redis 7 integration behavior、CIのnode-redisは6.2.x
- Cloudflare Workers / SQLite Durable Objects local workerd integration + documented real deployed dogfood evidence
- Firestore Emulator integration + `@google-cloud/firestore` 8.7.0 compatibility evidence

projectは別途v1 releaseがexplicitにauthorizeされるまでpre-v1です。current source APIはv1 release-candidate / final-release準備へ進める状態と評価しています。詳しくは [v1.0 readiness review](v1-readiness.ja.md)。
