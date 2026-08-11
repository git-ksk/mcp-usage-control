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

### `UsageObserver` / `UsageEvent`

```ts
interface UsageObserverHandler {
  onEvent(event: UsageEvent): void | Promise<void>;
}

type UsageObserver = UsageObserverHandler | undefined;
```

v0.1のevent union:

- `reserve.accepted`
- `reserve.denied`
- `settlement.completed`
- `reservation.recovered`
- `operation.error`

observer deliveryはbest-effortでenforcement outcomeの外側です。`onEvent()` 自体はinlineで呼びますが、返されたPromiseはawaitしません。同期callbackは軽量にし、network / durable I/Oはoffloadしてください。observerのsync throw / async promise rejectionは握りつぶし、admission / settlement stateを変更しません。tool argumentsやraw exception messageは自動収集しません。

`UsageEventMetadata` は明示opt-inの `Record<string, string | number | boolean | null>` です。

event field、privacy / cardinality指針、replay deduplication、Redis aggregate recovery、delivery guaranteeは [Observability](observability.ja.md) を参照してください。

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

default reservation TTLは `60_000` msです。従来のnumber形式の第3引数もsource-compatibleです。

`reserve(request)` はpolicy評価、budget validation/canonicalization、storeのatomic admissionを行い、設定されていればruntime lifecycle eventを発火します。metadata callbackは明示opt-inで、callback failureはenforcementへ影響させず無視します。

`resumeLease(state)` は既存reservationへ再attachし、`policy.quote()` / `store.reserve()` を再実行しません。trusted server-sideの `UsageLeaseResumeState` 専用で、resume後のrenew / settleはunderlying storeをauthoritative stateとして引き続き検証します。

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

store denial reasonは `quota_exceeded` / `duplicate_operation` です。`quota_exceeded` はlimiting budgetとremaining unitsを含む場合があります。policy denialはpolicy側reasonを返します。policy denial reasonはobserverへ出る場合があるため、free-form diagnostic textではなくboundedかつnon-secretなreason codeを使ってください。

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

trusted server-side suspend/resume用のserializable stateです。client credentialではありません。raw structureをuntrusted clientへ渡さず、clientにはintegrity-protectedなopaque referenceだけを渡し、実lease stateはserver-sideに保持してください。

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

`markLiable()` はmetered execution boundaryへ入ったことを宣言します。pending expiryはcapacityを解放できますが、cost-liable expiryはfull chargeを保守的に維持します。

`renew()` はactive leaseを延長します。`settle()` はreservationに参加した全budgetへ同じactual unit countを確定します。v0.1では `actualUnits <= reservedUnits` が必要です。

`toResumeState()` はtrusted server-side flow storage向けのdetached snapshotを返します。`UsageControl.resumeLease()` でreattachでき、quote / reserveを二重実行しません。

`UsageControl` 経由でobserverを設定した場合、lease errorとsuccessful settlementもeventを発火します。observer failureはlease結果を変更しません。

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

同一settlement replayはtombstone retention中idempotentです。actual units / outcomeが異なるreplayはfailします。同一内容のidempotent settlementを再度呼ぶと、同じ `settlement.completed` eventが再発火する場合があります。dedupeが必要なdownstream consumerは `(reservationId, actualUnits, outcome)` 等をkeyにしてください。observabilityはdurable ledgerではありません。

### `MemoryUsageStore`

```ts
new MemoryUsageStore({
  idempotencyTtlMs?,
  observer?,
})
```

test / development向けprocess-local reference storeです。settled replay tombstoneのdefault retentionは `86_400_000` ms（24時間）です。

pending expiryは参加する全budgetを解放しoperation IDを再利用可能にします。cost-liable expiryはfull reservationを消費済みとして確定し、boundedなsettled tombstoneを残します。observer設定時はper-reservationの `reservation.recovered` eventを発火します。

### Core errors

- `UsageStateError` — invalid / expired / conflictingなstore / resume state。
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

supportedなmulti-round `input_required` accountingには `protectTool()` ではなく `protectMultiRoundTool()` を使います。

### `McpUsageRequestStatePayload`

```ts
interface McpUsageRequestStatePayload {
  mcpUsageControl: 1;
  flowId: string;
}
```

MCP server側の `requestState.verify` hookでdecode済みのpayloadを想定します。wire valueは公式SDK `createRequestStateCodec()` 等のintegrity-protected codecでmintしてください。raw client-controlled stringは `protectMultiRoundTool()` がrejectします。

### `McpUsageFlowBinding`

```ts
interface McpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}
```

suspended flow claim前にserver-sideで比較するtrusted bindingです。`argsHash` はvalidated tool argumentsをcanonicalizeしたSHA-256 hashです。

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

`consume()` はsecurity-criticalです。現在のtrusted bindingとatomicに比較し、matchしたflowだけをexactly one callerへconsumeする必要があります。mismatch callerにはno recordを返し、**正規flowを削除してはいけません**。

### `MemoryMcpUsageFlowStore`

`McpUsageFlowStore` のprocess-local reference implementationです。test / single-process server向けで、per-request `createMcpHandler` factoryの外側で生成します。horizontal scaleするserverは同じatomic compare-and-consume contractを持つshared/durable implementationが必要です。

### `McpUsageFlowContext`

```ts
interface McpUsageFlowContext {
  readonly round: number;
  readonly operationId: string;
  readonly applicationRequestState?: string;
}
```

`protectMultiRoundTool()` がapplication handlerの第3引数へ渡します。`round` は0開始、最初のresume requestは1です。`operationId` は初回roundのlogical IDです。前roundでapplicationが独自 `requestState` を返した場合、wrapperはwire値として信用せずserver-sideに保持し、ここへ `applicationRequestState` として渡します。

### `ProtectMultiRoundToolOptions<TArgs, TResult>`

`ProtectToolOptions` に以下を追加します。

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

`suspendTtlMs` は必須です。cost-liable suspended leaseを保守的expiry recoveryまで保持する時間をboundします。`flowId` は主にtest/customization用hookで、defaultはcryptographically randomなIDです。

### `protectMultiRoundTool(options, handler)`

MCP v2 multi-round向けopt-in wrapperです。

behavior:

- first roundでprincipal / operation IDを導出し、1回だけreserveしてleaseをliable化。
- `input_required` 時はactive heartbeatを止め、`suspendTtlMs` でrenew、trusted server-side flow recordを保存し、wrapper-owned signed/opaque `requestState` を返す。
- resume roundはverified decoded request-state payloadとatomic binding-aware flow consumeを必須にする。
- resume roundはquote / reserveせず `UsageControl.resumeLease()` で同じleaseへreattachし、authoritative underlying reservationをrenewする。
- one-time resume tokenでhandler再入場は1 callerだけ。replay / expired / missing / mismatched stateは `McpUsageResumeError` でfail-close。
- `maxRounds` 超過はfull reservationを保守的にsettleして `McpUsageRoundsExceededError`。
- final success / tool-error / throwのclassification / settlementは `protectTool()` と同じrule。

同じresume tokenでのdouble reservation / duplicate application re-entryを防ぎますが、任意のside effectに対するgeneral exactly-once guaranteeやcompleted business result cache/replayは提供しません。destructive / externally metered workでは既存のbusiness idempotency / reconciliationを維持してください。

公式SDK request-state設定とtrust boundaryは [MCP integration](mcp-integration.ja.md) を参照してください。

### MCP adapter errors

- `UsageSettlementError` — `settlementError` とoptional `executionError`。
- `UsageClassificationError` — `classificationError` とoptional `executionError`。
- `UnsupportedMcpUsageFlowError` — single-round `protectTool()` の `input_required` boundary error。
- `McpUsageResumeError` — missing / expired / replayed / mismatched / unverifiedなmulti-round resume state。
- `McpUsageRoundsExceededError` — configured `maxRounds` を超え、full conservative settlement後に返るerror。

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
  observer?: UsageObserver;
}
```

default:

- `prefix`: `muc`
- `hashTag`: `usage`
- `cleanupBatchSize`: `256`
- `idempotencyTtlMs`: `86_400_000`（24時間）

v0.1 Redis storeは1 transaction domain内にused-budget hash、global lease expiry index、reservation records、operation mappings、tombstonesを保持します。budget ID / operation identityはstorage identifier化前にhashします。

Luaはlease / tombstone判定にRedis server `TIME` を使います。multi-budget reserve / release / expiry recovery / renew / settlementをclient側single-budget loopへ分解しません。

`observer` 設定時、lazy cleanupはpending-release / liable-retentionについてaggregate `reservation.recovered` eventを発火します。telemetryのためだけにraw principal、tenant、tool、budget stringを永続化しません。expired reservationを直接操作した場合はopaqueなhashed reservation IDをeventへ含む場合があります。

詳細は [Redis adapter](redis.ja.md) と [Observability](observability.ja.md) を参照してください。

## `mcp-usage-control-cloudflare`

### `CloudflareUsageStore`

Durable Object namespaceを使うWorker-local `UsageStore`。optionは `domainName`、`cleanupBatchSize`、`idempotencyTtlMs`、`observer`。1 `domainName` が1 atomic transaction domainです。

### `RemoteCloudflareUsageStore`

Cloudflare外のapplication向けHTTP `UsageStore`。`endpoint` は必須で、local以外はHTTPSのみ許可します。request headerは直接またはcallbackで指定できます。`timeoutMs` はasync header resolution、fetch、response decodeを含むfull-call deadlineです。timeout / network failureは `CloudflareUsageTransportError` として表面化し、自動retryしません。non-auth HTTP failureは `code: 'remote'` のまま、boundedな数値 `status` metadataだけをoptionalに保持し、response bodyは公開しません。

### `createCloudflareUsageStoreGateway()`

remote store向けWorker HTTP handlerを作成します。application-defined `authorize(request)` callbackが必須です。gatewayはadapterが生成するhashed accounting protocolだけを受け取り、raw Durable Object exceptionを返しません。

### `UsageControlDurableObject`

`mcp-usage-control-cloudflare/worker` からexportします。SQLite transactionでatomic multi-budget reserve、liability、renewal、settlement、replay protection、expiry recoveryを処理します。

詳細は [Cloudflare adapter](cloudflare.ja.md) を参照してください。

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
