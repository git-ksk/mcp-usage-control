# API reference

[English](api-reference.md) | [日本語](api-reference.ja.md)

> Pre-alpha: このreferenceはcurrent `main` APIを説明します。v0.1まではname / signatureが変更される可能性があります。

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

1つのlogical usage-controlled invocationを表します。`operationId` はduplicate protectionに利用し、同一logical invocationのretryではstableにしてください。

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

policyが定義するaccounting bucketです。time windowを使う場合はwindow-qualified keyを明示してください。

### `UsageQuote`

```ts
type UsageQuote =
  | {
      decision: 'allow';
      units: number;
      budget: Budget;
      reservationTtlMs?: number;
    }
  | {
      decision: 'deny';
      reason: string;
    };
```

policy outputです。allowされたquoteはexecution前に `units` をreserveします。`reservationTtlMs` を指定すると、そのrequestだけ `UsageControl` default TTLをoverrideします。

### `UsagePolicy`

```ts
interface UsagePolicy {
  quote(request: UsageRequest): UsageQuote | Promise<UsageQuote>;
}
```

application-definedのadmission / quoting policyです。

### `UsageStore`

```ts
interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult>;

  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}
```

storage contractです。production implementationは [Architecture](architecture.ja.md) のatomicity / failure invariantを守る必要があります。

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);
```

default reservation TTLは60,000 msです。`reserve(request)` はpolicy評価、quote validation、storeによるatomic admissionを実行し、`AdmissionResult` を返します。

### `AdmissionResult`

```ts
type AdmissionResult =
  | { allowed: true; lease: UsageLease }
  | { allowed: false; reason: string; remaining?: number };
```

store built-in denial reasonは現在 `quota_exceeded` と `duplicate_operation` です。policyは独自のdeny reasonを返せます。

### `UsageLease`

主なmember:

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`renew()` はpending leaseを延長します。`settle()` はactual usageを確定します。現在のstore contractでは `actualUnits <= reservedUnits` が必要です。

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

callerから見たadmitted pending reservationを表します。

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

`UsageStateError` はexpired reservationやconflicting settlement replayなど、invalid / conflicting store stateを示します。

`UsageDeniedError` はadmission failureをexceptionとして扱うadapter向けにdeny reasonを保持します。

### `MemoryUsageStore`

test / local development向けのreference `UsageStore` implementationです。process-localでありproduction distributed storeではありません。

## `@mcp-usage-control/mcp`

### `protectTool(options, handler)`

`@modelcontextprotocol/server` v2 tool handlerをreserve、optional heartbeat、execution、settlement behaviorでwrapします。

```ts
interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  principal(ctx: ServerContext): Principal | Promise<Principal>;
  operationId(
    args: TArgs,
    ctx: ServerContext,
  ): string | Promise<string>;
  leaseHeartbeat?: boolean;
  successUnits?(input: {
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

behavior:

- `leaseHeartbeat` はdefault enabled。
- `successUnits` 未指定のsuccessはfull reservationをsettle。
- `errorUnits` 未指定のfailureはfull reservationをsettle。
- admission denyはhandler execution前に `UsageDeniedError` をthrow。
- settlement failureは `UsageSettlementError` をthrowし、盲目的にretryしない。

利用方法とsafety noteは [MCP integration](mcp-integration.ja.md) を参照してください。

### `UsageSettlementError`

次を保持します。

```ts
settlementError: unknown
executionError?: unknown
```

tool error後のsettlementが失敗した場合、`executionError` に元のexecution failure、`settlementError` にaccounting failureを保持します。

## `@mcp-usage-control/redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?);
```

clientはadapterの `RedisEvalClient` interfaceと互換な `eval(script, { keys, arguments })` methodを持つ必要があります。

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
- `idempotencyTtlMs`: `86_400_000`（24時間）

`prefix` / `hashTag` ではRedis hash-tag braceを拒否し、adapterがtransaction domainを管理します。

key layout、cleanup、acknowledgement ambiguity、Redis Cluster trade-offは [Redis adapter](redis.ja.md) を参照してください。

## Numeric validation

unit / limitはJavaScript safe integerとして扱います。unit / limitはnon-negative、TTLやcleanup / retention durationは受け付ける箇所でpositive safe integerが必要です。

## Compatibility

現在のrepository target:

- Node.js 20+
- `@modelcontextprotocol/server` v2（現在2.0.0に対してbuild）
- Redis 7 integration behavior
- workspaceのnode-redis `redis` 6.2.x

これらはpre-alpha compatibility targetであり、まだlong-term support promiseではありません。