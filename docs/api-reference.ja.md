# API reference — current source

[English](api-reference.md) | [日本語](api-reference.ja.md)

このreferenceはcurrent source treeのpublic APIを説明します。5 packageのmanifestは `0.12.0` に揃っています。**v0.12.0がcurrent GitHub/source release baseline**で、npm registry publicationは引き続き意図的にdeferredしています。

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

`key` はnon-empty、`limit` はnon-negative safe integerです。window semanticsはapplication policyの責務です。一般的な日次/月次keyには `createWindowedBudgetKey()` を使えます。契約更新日ベースなど独自windowでは、これまで通りapplication側でkeyを明示的に構築します。

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

### Weighted credit policy helper

MCP toolごとに同じcredit通貨を異なる量だけ消費する一般的なケースでは、`defineWeightedCreditPolicyConfig()` で**読み込み済みplain config object**をvalidateし、`createWeightedCreditsPolicy()` で通常の `UsagePolicy` を組み立てられます。このhelperが担当するのはdeterministicなquote compositionだけです。entitlement解決、configの読み込み/配布、accounting window identity、過去usage/billing ledgerはapplication側の責務のままです。

```ts
import {
  createWeightedCreditsPolicy,
  defineWeightedCreditPolicyConfig,
} from 'mcp-usage-control';

const creditConfig = defineWeightedCreditPolicyConfig({
  tools: {
    search: 1,
    summarize: 3,
    ai_analyze: 5,
    browser_action: 10,
  },
  plans: {
    free: { limits: { monthly: 50 } },
    plus: { limits: { monthly: 100 } },
  },
  unknownTool: 'deny',
});

const policy = createWeightedCreditsPolicy({
  config: creditConfig,
  budgets: ({ request, limit }) => ({
    // window/key構築はapplication-owned。plan名をidentityへ入れないことで、
    // Free -> Plusでも8月中に消費済みのusageをresetしない。
    key: `month:user:${request.principal.id}:2026-08`,
    limit: limit('monthly'),
  }),
});
```

未設定toolはdefaultで `unknown_tool` denyになります。必要な場合だけ `{ fallbackUnits }` を明示できます。planが未設定/unknownなら `unknown_plan` denyです。tool units、named plan limits、fallback units、unknown config field、固定reservation TTLは起動時にeager validationされます。またpolicy生成時にconfigをsnapshotするため、caller側objectを後からmutateしてactiveなcredit設定が勝手に変わることもありません。

`plans.*.limits` はsubscription databaseではなくnamed limit bagです。どのlimitをどの `Budget` に使うかはapplicationが `budgets()` で決めます。`limit(name)` は存在しないnameを指定するとfail closedします。trusted entitlement truthが `request.principal.plan` 以外にある場合は `resolvePlan` を指定できます。

このhelperが受け取るのは**すでに読み込み済みのobject**だけです。JSON/YAML/file/Remote Configへのアクセスは意図的にscope外です。通常のJSON parse後はduplicate textual keyの情報が失われるため、duplicate-key rejectが必要ならconfig loader側でparse前/parse時に保証してください。

Free / Plus月次creditsの完全なcomposition例は [サブスク型MCP creditsの実装パターン](subscription-credits.ja.md) を参照してください。

### `createWindowedBudgetKey()`

一般的な日次/月次budget identityには `createWindowedBudgetKey({ period, timeZone, namespace, clock? })` を使えます。`key({ scope, id, now? })` でdeterministicかつcomponent-safeなkeyを作ります。`window({ scope, id, now? })` は同じtimezone/calendar計算から、そのkeyとinclusiveな `startsAt` / exclusiveな `endsAt` を一緒に返します。`endsAt` はknown next-resetとしてclient UXへ使えますが、non-authoritative metadataであり、任意のapplication-defined keyからresetを推測することはありません。設定したtimezone文字列自体もaccounting identityへ含まれるため、timezone / namespace / period / scope形式を変えると既存stateのrollover semanticsを黙って変えるのではなく、意図的に別keyを選びます。詳しくは[利用枠の期間を表すbudget key](accounting-window-keys.ja.md)を参照してください。

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

### `UsageOperationReconciliationInput` / `UsageOperationReconciliation` / `OperationReconciliationStore` (v0.8)

```ts
interface UsageOperationReconciliationInput {
  request: UsageRequest;
  units: number;
  budgets: readonly Budget[];
}

type UsageOperationReconciliation =
  | { status: 'absent'; reservationId: string }
  | { status: 'active'; state: 'pending' | 'liable'; reservation: ReservationRecord }
  | { status: 'expired'; state: 'pending' | 'liable'; reservationId: string; expiredAt: number }
  | {
      status: 'settled';
      reservationId: string;
      reservedUnits: number;
      actualUnits: number;
      tombstoneExpiresAt: number;
    };

interface OperationReconciliationStore extends UsageStore {
  reconcileOperation(
    input: UsageOperationReconciliationInput,
  ): Promise<UsageOperationReconciliation>;
}
```

optionalな **scalar-only / read-only** Store capabilityです。2個目のreservationを作成したり、liability / lease / settlement stateを変更したりせず、retained usage-enforcement stateだけを証明します。inputにはtrusted logical operation identity、期待するcurrent retained scalar units、expected budget keyを使います。mutable budget limitはhistorical identityではないため、過去値との一致を要求しません。

`absent` は現在retained stateが見えないことだけを意味し、Store retention horizon後は「operationが過去に存在しなかった」証明ではありません。transport/backend failure、corrupt/unsupported state、identity/quote mismatchは`absent`へ変換せずrejectし、callerはindeterminateとしてfail closedします。詳しくは [Operation reconciliation / status](operation-reconciliation.ja.md) を参照してください。

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

`stats()` は現在のretained operation / budget-key数とconfigured limitを返します。これはconsumed usageではなくretention pressureのcounterで、`retainedOperations` にはactive reservationとreplay tombstoneが含まれます。`retireBudgetKey()` は終了済みaccounting windowのkeyを明示的に忘れるためのAPIで、active reservationが参照中のkeyはrejectします。application側は、retireしたkeyを同じaccounting windowとして再利用しないことを保証する必要があります。non-zero usageのgeneric automatic TTL / LRU evictionはquota semanticsをresetし得るため意図的に行いません。

expiry / tombstone cleanupはlazyで、store callごとの全件scanではなく最も早い既知deadlineを基準に実行します。ただしprocess-localのままで、horizontal / restart durableなproduction Storeではありません。詳しくは [Memory Storeの長期運用](memory-store.ja.md)。

### `UsageObserver` / `UsageEvent`

```ts
interface UsageObserverHandler {
  onEvent(event: UsageEvent): void | Promise<void>;
}

type UsageObserver = UsageObserverHandler | undefined;
```

current lifecycle eventにはscalar/vector reserve、settlement、recovery、`operation.error` が含まれます。observer deliveryはbest-effortでenforcement transactionの外側です。返されたPromiseはawaitせず、sync throw / async rejectionもaccounting outcomeを変えません。

`UsageEventMetadata` はexplicit opt-in `Record<string, string | number | boolean | null>` です。

### `projectUsageEvent()`

raw lifecycle eventをlow-cardinalityなoperational shapeへprojectします。defaultではidentity ID、operation / reservation ID、tool / budget identifier、unrestricted settlement outcome、application-defined denial textを除外します。

observabilityでありtransactional ledgerではありません。

### Core errors

- `UsageStateError` — invalid / expired / missing / conflicting Store・resume state
- `UsageDeniedError` — programmatic denial reasonを保持しつつ、thrown messageはgeneric
- `MemoryUsageStoreCapacityError` — boundedなin-memory operation / budget-key retentionが上限に達した状態。accounting stateをevictせず保持し、fail closedする

## `mcp-usage-control/operational` (v0.10)

```ts
import {
  MCP_USAGE_CONTROL_PACKAGE_NAME,
  MCP_USAGE_CONTROL_VERSION,
  UsageOperationalMonitor,
  createUsageRuntimeIdentity,
  projectScopedQuota,
} from 'mcp-usage-control/operational';
```

`createUsageRuntimeIdentity()` はbounded static diagnostic metadataを構築します。package name/version、provider (`memory` / `redis` / `firestore` / `cloudflare` / `custom`)、optional capability flag、provider側でstableな意味をdocumentできる場合だけoptional storage schema versionを含めます。

`UsageOperationalMonitor` はprocess-local `UsageObserverHandler` です。`snapshot()` はbounded lifecycle/error counter、optional runtime identity、last observed event timestampを返します。principal / operation / reservation / tool / budget identifierを公開せず、replayable / aggregate eventからauthoritative active-reservation数を推測しません。

`projectScopedQuota(limit, remaining)` はapplicationが選択済みの **authoritative budget/window 1つ** を `{ limit, remaining, used, exhausted, utilization }` へprojectします。budget keyを受け取らず、window discovery/resetも行いません。

これらはnon-authoritative helperで、enforcementを変更できません。

## `mcp-usage-control/settlement-outcomes` (v0.10)

```ts
import {
  CANONICAL_SETTLEMENT_OUTCOMES,
  DEFAULT_SETTLEMENT_OUTCOME_ALIASES,
  InvalidSettlementOutcomeError,
  isCanonicalSettlementOutcome,
  normalizeSettlementOutcome,
} from 'mcp-usage-control/settlement-outcomes';
```

canonical value:

- `authorization_denied`
- `invalid_arguments`
- `pre_dispatch_rejected`
- `pre_dispatch_no_effect`
- `cancelled_before_dispatch`
- `completed`
- `proven_no_effect`
- `dispatched_conservative`
- `cancelled_after_dispatch`

`normalizeSettlementOutcome()` はcanonical valueをそのまま受け取り、bounded compatibility aliasとapplication-owned finite alias map（例: `invalid_browser_request -> invalid_arguments`）を利用できます。

unsupported / malformed vocabularyはcode `invalid_settlement_outcome` の `InvalidSettlementOutcomeError` をthrowします。rejectしたraw valueはerrorへ保持しません。optional best-effort diagnostic sinkはbounded codeを観測できますが、normalization errorを置換したりsettlement behaviorを変更したりできません。

## `mcp-usage-control/thresholds` (v0.10)

```ts
import {
  didUsageQuotaThresholdCross,
  evaluateUsageQuotaThreshold,
} from 'mcp-usage-control/thresholds';
```

対応thresholdは `{ kind: 'remaining_units', value: N }` と `{ kind: 'remaining_ratio', value: 0..1 }` です。

helperはexplicit `ScopedQuotaSnapshot` のみを対象にします。`didUsageQuotaThresholdCross(previous, current, threshold)` はabove -> reached transitionを返し、previous state persistenceとaccounting-window resetはcallerが所有します。configured limitが変わった場合、同一windowと推測せずrejectします。notification delivery / retry / deduplicationはcore外です。

詳しくは [Operational usability](operational-usability.ja.md)。

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

base portable runnerはmulti-budget atomicity、concurrent admission、replay scope、liability idempotency、renewal、settlement replay / conflict、invalid-settlement non-corruption、pending / liable expiryなどprovider-neutral behaviorを確認します。

v0.8ではoptional `OperationReconciliationStore`向けに `runOperationReconciliationStoreConformance()` / `assertOperationReconciliationStoreConformance()` もexportします。`absent -> pending -> liable -> settled`、expired stateのread-only観測、expected-state mismatchのfail-closeを確認します。

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

Cloudflare外application向けHTTP Storeです。local以外はHTTPS必須。optional request headerはstatic / callbackで指定でき、`timeoutMs` はfull remote callをboundedし、portableなsingle `setTimeout` 上限である `2_147_483_647` ms以下である必要があります。MCP lease heartbeatはreservation TTL自体をこの値へ制限せず、それを超える待機時間をbounded chunkへ分割してplatform timer overflowを避けます。

network / timeout / ambiguous remote failureはsurfaceしautomatic retryしません。transport errorへresponse bodyを伝播しません。

### `createCloudflareUsageStoreGateway()`

authenticated Worker gatewayを作ります。application-defined `authorize(request)` がmandatoryで、unauthenticated defaultはありません。

### `mcp-usage-control-cloudflare/worker`

Durable Object implementationをexportし、`UsageControlDurableObject` とdeployment用versioned Worker entry pointを含みます。

### `mcp-usage-control-cloudflare/reconciliation`

authenticated read-only scalar operation reconciliation helperをexportします。`reconcileRemoteCloudflareOperation()` がv0.8のprovider-neutral operation-status entry pointで、`reconcileRemoteCloudflareReserve()` はambiguous initial-reserve ACK recovery向けv0.7互換aliasとして維持します。reconciliationで追加quotaを作りません。

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

## Progressive reservation growth（v0.6）

`ReservationRecord`にはopaqueな`growthCursor`が付く場合がある。`UsageLease.grow({ incrementId, additionalUnits, budgets })`はsame logical reservationのcapacityを増加要求し、accepted/deniedの`StoreGrowResult`を返す。Store/transport errorがthrowされた場合attemptはunresolvedのままで、authoritative resultが得られるまで同じleaseはexact retryだけを許可する。

Storeは`ProgressiveUsageStore.growReservation()`でopt-inする。base `UsageStore` interfaceは変更しないため、既存third-party fixed-reservation Storeは互換のまま。

public conformance subpathはgrowth supportをclaimするStore向けに`runProgressiveUsageStoreConformance()`もexportする。

詳細は[Progressive reservation growth](progressive-reservation-growth.ja.md)を参照。

## Vector usage API (v0.7)

`VectorUsagePolicy` は1 scalar `units`ではなくcanonical dimension vectorを返します。configured Storeがoptional `VectorUsageStore`を実装する場合、`VectorUsageControl.reserve()`は`VectorUsageLease`を返します。

`VectorUsageLease`は`reservedByDimension`、`markLiable()`、`renew()`、`grow()`、`settle()`、`toResumeState()`を提供します。`grow()`はstable `incrementId` 1個とcomplete dimension/budget topologyを受け取り、`settle()`は全dimensionを`{ key, actualUnits }`としてexactly once受け取ります。

`VectorUsageStore`はshared lifecycleを`UsageStore`から継承しつつ、`reserveVector()` / `growVectorReservation()` / `settleVector()`を追加します。既存third-party scalar Storeにこれらの実装は必須ではありません。

public `runVectorUsageStoreConformance()`はatomic admission、replay/cursor、expiry、settlement bound、scalar/vector operation collision、growth/settlement raceを検証します。詳細は[Atomic heterogeneous usage vector](vector-usage.ja.md)を参照。
