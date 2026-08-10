# API reference — v0.1

[English](api-reference.md) | [日本語](api-reference.ja.md)

## `mcp-usage-control`

### `Principal`

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

applicationが渡すtrustedなaccounting identityです。authentication primitiveではありません。

### `UsageRequest<TArgs>`

```ts
interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}
```

replay protectionは `(tenantId, principal.id, tool, operationId)` 単位です。同じlogical invocationのretryではstableな `operationId` を使います。

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

policy-defined accounting bucketです。keyはnon-empty string、limitはnon-negative safe integerです。daily/monthly windowは明示的にkeyへ含めます。

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

`budgets` がv0.1のmulti-budget形式です。quoted unitsを列挙したすべてのbudgetへatomicにreserveします。1 budgetだけの場合は `budget` を簡易aliasとして利用できます。empty list / duplicate budget keyはrejectします。

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

production implementationはmulti-budget admissionをall-or-nothingにし、[Architecture](architecture.ja.md) のlifecycle / failure invariantを維持する必要があります。

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);
```

default reservation TTLは `60_000` msです。

`reserve(request)` はpolicy評価、budget validation/canonicalization、storeのatomic admissionを行います。

### `AdmissionResult`

```ts
type AdmissionResult =
  | { allowed: true; lease: UsageLease }
  | {
      allowed: false;
      reason: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };
```

store denial reasonは `quota_exceeded` / `duplicate_operation` です。`quota_exceeded` はlimiting budgetとremaining unitsを含む場合があります。policy denialはpolicy側reasonを返します。

### `ReservationRecord`

```ts
interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  tool: string;
  budgetKeys: string[];
  reservedUnits: number;
  expiresAt: number;
}
```

### `UsageLease`

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
await lease.markLiable()
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`markLiable()` はmetered execution boundaryへ入ったことを宣言します。pending expiryはcapacityを解放できますが、cost-liable expiryはfull chargeを保守的に維持します。

`renew()` はactive leaseを延長します。`settle()` はreservationに参加した全budgetへ同じactual unit countを確定します。v0.1では `actualUnits <= reservedUnits` が必要です。

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

同一settlement replayはtombstone retention中idempotentです。actual units / outcomeが異なるreplayはfailします。

### `MemoryUsageStore`

```ts
new MemoryUsageStore({ idempotencyTtlMs? })
```

test / development向けprocess-local reference storeです。settled replay tombstoneのdefault retentionは `86_400_000` ms（24時間）です。

pending expiryは参加する全budgetを解放しoperation IDを再利用可能にします。cost-liable expiryはfull reservationを消費済みとして確定し、boundedなsettled tombstoneを残します。

### Core errors

- `UsageStateError` — invalid / expired / conflictingなstore state。
- `UsageDeniedError` — programmaticな `.reason` を保持しつつ、MCP SDK error変換による情報漏洩を避けるためthrow messageはgenericです。

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

input schemaがないtoolでは `noInput: true` が必要です。input schemaありでは省略またはfalseにします。no-input modeではSDK public `(ctx)` callback shapeと実runtimeで観測される `({}, ctx)` dispatchの両方を内部normalizeし、policy / hook / application handlerには `args === undefined` を渡します。

### `protectTool(options, handler)`

**single-round** MCP TypeScript SDK v2 tool handlerへadmission / settlementを追加します。

behavior:

- handler前にreserve。
- application handler entry直前に `markLiable()`。
- handler実行中のheartbeatはdefault enabled。
- normal result -> `successUnits` またはfull reservation。
- `{ isError: true }` -> `toolErrorUnits` またはfull reservation。
- thrown exception -> `errorUnits` またはfull reservation。
- invalid / throwing classifier -> full conservative settlement後に `UsageClassificationError`。
- settlement failure -> `UsageSettlementError`。blind retryしません。
- `resultType: 'input_required'` -> conservative settlement後に `UnsupportedMcpUsageFlowError`。

v0.1はmulti-round `input_required` supportをclaimしません。[MCP integration](mcp-integration.ja.md) とIssue #14を参照してください。

### MCP adapter errors

- `UsageSettlementError` — `settlementError` とoptional `executionError`。
- `UsageClassificationError` — `classificationError` とoptional `executionError`。
- `UnsupportedMcpUsageFlowError` — v0.1のmulti-round `input_required` support boundary。

## `mcp-usage-control-redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?)
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
- `idempotencyTtlMs`: `86_400_000`（24時間）

v0.1 Redis storeは1 transaction domain内にused-budget hash、global lease expiry index、reservation records、operation mappings、tombstonesを保持します。budget ID / operation identityはstorage identifier化前にhashします。

Luaはlease / tombstone判定にRedis server `TIME` を使います。multi-budget reserve / release / expiry recovery / renew / settlementをclient側single-budget loopへ分解しません。

詳細は [Redis adapter](redis.ja.md) を参照してください。

## Numeric validation

- units / limits: non-negative JavaScript safe integer。
- TTL / retention duration: positive safe integer。
- settlement / classifier result: non-negative safe integerかつ `<= reservedUnits`。

## v0.1 compatibility

- Node.js 20+
- ESM package
- `@modelcontextprotocol/server` v2。CIでは現在 `2.0.0` をresolve。
- Redis 7 integration test
- node-redis `redis` 6.2.x

pre-1.0 minor releaseではintentional breaking changeを含む場合があります。その場合はrelease notesへ明記します。
