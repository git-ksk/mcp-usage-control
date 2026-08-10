# API reference

[English](api-reference.md) | [日本語](api-reference.ja.md)

> Pre-alpha: このreferenceは現在のdevelopment APIを説明します。v0.1まではname / signatureが変更される可能性があります。

## `@mcp-usage-control/core`

### `Principal`

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

applicationが渡すaccounting identityです。authentication primitiveではありません。

### `UsageRequest<TArgs>`

```ts
interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}
```

1つのlogical usage-controlled invocationです。`operationId` はduplicate protectionに使い、同じlogical invocationのretryではstableである必要があります。

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

policy-defined accounting bucketです。time windowには明示的なwindow-qualified keyを使ってください。

### `UsageQuote` / `UsagePolicy`

```ts
type UsageQuote =
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

### `UsageStore`

```ts
interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult>;

  markLiable(input: MarkLiableInput): Promise<MarkLiableResult>;
  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}
```

production implementationは [Architecture](architecture.ja.md) のatomicity / failure invariantを維持する必要があります。

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);
```

default reservation TTLは60,000msです。`reserve(request)` はpolicy評価、quote validation、storeのatomic admissionを実行し `AdmissionResult` を返します。

### `AdmissionResult`

```ts
type AdmissionResult =
  | { allowed: true; lease: UsageLease }
  | { allowed: false; reason: string; remaining?: number };
```

store built-inのdenial reasonは現在 `quota_exceeded` と `duplicate_operation` です。policyは独自reasonを返せます。

### `UsageLease`

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
await lease.markLiable()
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`markLiable()` はmetered execution boundaryへ入ったことを宣言します。そのactive leaseがsettlement前にexpireした場合、production storeはreservationをrefundせず保守的に消費済みとして維持します。

`renew()` はactive leaseを延長し、`settle()` はactual usageを確定します。現在のcontractでは `actualUnits <= reservedUnits` が必要です。

### `ReservationRecord`

```ts
interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tool: string;
  budgetKey: string;
  reservedUnits: number;
  expiresAt: number;
}
```

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

### Errors

`UsageStateError` はinvalid / expired / conflictingなstore stateを表します。

`UsageDeniedError` はprogrammaticな `.reason` を保持しますが、throw messageは意図的にgenericな `Usage denied by usage policy` です。MCP SDKのerror変換でinternal policy detailが自動露出することを防ぎます。

### `MemoryUsageStore`

test / local development向けreference implementationです。pending / cost-liable / settled lifecycleを扱いますがprocess-localであり、distributed production storeではありません。

## `@mcp-usage-control/mcp`

### `ProtectToolOptions<TArgs, TResult>`

```ts
interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  noInput?: boolean;
  principal(ctx: ServerContext): Principal | Promise<Principal>;
  operationId(args: TArgs, ctx: ServerContext): string | Promise<string>;
  leaseHeartbeat?: boolean;
  successUnits?(input: {
    result: TResult;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): number | Promise<number>;
  toolErrorUnits?(input: {
    result: TResult;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): number | Promise<number>;
  errorUnits?(input: {
    error: unknown;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): number | Promise<number>;
}
```

input schemaがないtoolでは `noInput: true` を指定します。input schemaがあるtoolでは `noInput` を省略するかfalseにします。

このflagを明示するのは意図的です。SDKのpublic typeではno-input callbackを `(ctx)` と表現しますが、現在のdispatch pathではruntime上 `({}, ctx)` で呼ばれる場合があります。`{}` はempty object schemaの正当な入力にもなるため、adapterはruntime valueだけから推測しません。

`noInput: true` modeではpolicy request、各hook、operation-ID callback、wrapped application handlerへ `args === undefined` と正しい `ServerContext` を渡します。

### `protectTool(options, handler)`

**single-round** `@modelcontextprotocol/server` v2 tool handlerへreserve、cost-liable activation、heartbeat、execution classification、settlementを追加します。

public overloadは概念的に次の形です。

```ts
protectTool<TResult>(
  options: ProtectToolOptions<undefined, TResult> & { noInput: true },
  handler: (args: undefined, ctx: ServerContext) => TResult | Promise<TResult>,
): (ctx: ServerContext) => Promise<TResult>;

protectTool<TArgs, TResult>(
  options: ProtectToolOptions<TArgs, TResult> & { noInput?: false },
  handler: (args: TArgs, ctx: ServerContext) => TResult | Promise<TResult>,
): (args: TArgs, ctx: ServerContext) => Promise<TResult>;
```

runtimeではno-input overloadについてSDK dispatchの `({}, ctx)` 形式も受け入れ、内部でnormalizeします。

behavior:

- admitted leaseはhandler entry前にcost-liableへ遷移します。
- `leaseHeartbeat` はdefaultでenabledです。
- normal successは `successUnits` またはfull reservationを使います。
- MCP `{ isError: true }` resultは `toolErrorUnits` またはfull reservationを使います。
- thrown errorは `errorUnits` またはfull reservationを使います。
- classifierがthrow / invalid valueを返した場合、full reservationを保守的にsettleした後 `UsageClassificationError` を返します。
- admission denialはhandler実行前に `UsageDeniedError` をthrowします。
- settlement failureは `UsageSettlementError` となり、blind retryしません。
- `resultType: 'input_required'` は現在未対応で、保守的settlement後に `UnsupportedMcpUsageFlowError` を返します。

詳しくは [MCP integration](mcp-integration.ja.md) を参照してください。

### `UsageSettlementError`

```ts
settlementError: unknown
executionError?: unknown
```

ambiguous / failed accounting settlementを表します。

### `UsageClassificationError`

```ts
classificationError: unknown
executionError?: unknown
```

cost classifierが失敗またはinvalid unitsを返したため、wrapperがfull reservationを保守的にsettleした後に返されます。

### `UnsupportedMcpUsageFlowError`

現在はMCP v2 `input_required` multi-round tool resultに使います。suspend/resume accountingはまだ実装していません。

## `@mcp-usage-control/redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?);
```

clientは `RedisEvalClient` compatibleな `eval(script, { keys, arguments })` methodを必要とします。

### `RedisUsageStoreOptions`

```ts
interface RedisUsageStoreOptions {
  prefix?: string;
  hashTag?: string;
  cleanupBatchSize?: number;
  idempotencyTtlMs?: number;
}
```

default:

- `prefix`: `muc`
- `hashTag`: `usage`
- `cleanupBatchSize`: `256`
- `idempotencyTtlMs`: `86_400_000` (24時間)

lease / tombstone timestampはapplication clockではなくLua内のRedis server timeから計算します。key layout、cleanup、cost-liable expiry、ACK ambiguity、durability boundary、Redis Cluster trade-offは [Redis adapter](redis.ja.md) を参照してください。

## Numeric validation

units / limitsはJavaScript safe integerです。units / limitsはnon-negative、TTL / retention durationは受け付ける箇所でpositive safe integerが必要です。classifier resultも `reservedUnits` 以下である必要があります。

## Compatibility

現在のrepository target:

- Node.js 20+
- `@modelcontextprotocol/server` v2（現在2.0.0でbuild/test）
- Redis 7 integration behavior
- workspaceのnode-redis `redis` 6.2.x

pre-alphaのcompatibility targetであり、まだlong-term support promiseではありません。