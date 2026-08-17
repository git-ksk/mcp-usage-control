# Atomic heterogeneous usage vector

状態: **v0.7 contract。future v1 surfaceへoptional Store capabilityとして採用。**

v0.7では、1つのlogical operationがrequest数・model token・compute秒・provider work unitなど異なる単位を同時に消費するためのtyped vector accounting pathを追加します。既存scalar `UsageControl` / `UsageStore` contractは変更しません。

## なぜvector専用surfaceにするか

例えば:

```text
requests = 1
tokens   = 800
```

を`801 units`として扱ってはいけません。単位・limit・settlement値・policy上の意味が異なります。そのためv0.7ではscalar return typeをunion化したり異種unitを加算したりせず、別のvector surfaceを追加します。

主なapplication-facing type:

- `VectorUsagePolicy`
- `VectorUsageControl`
- `VectorUsageLease`
- optional `VectorUsageStore`

policyはcanonicalなdimensionを返します。

```ts
{
  decision: 'allow',
  dimensions: [
    { key: 'requests', units: 1, budgets: [{ key: 'user:requests:day', limit: 100 }] },
    { key: 'tokens', units: 800, budgets: [{ key: 'user:tokens:day', limit: 100_000 }] },
  ],
}
```

各dimensionは複数hierarchical budgetへ参加できます。同一vector reservation内で1つのbudget keyを複数dimensionへ重複所属させることは禁止します。

## Admission invariant

1 logical operationに必要な全dimensionは、1 authoritative Store transactionで**全部commitするか、全部commitしないか**のどちらかです。

「requestをreserveしてからtokenをreserve」のような独立callは同等ではありません。1個目だけcommitし、2個目がdeny / ambiguousになる可能性があります。`reserveVector()`はこのpartial-commit gapを閉じます。

scalarとvectorはlogical-operation replay domainも共有します。同じoperation identityをscalarとvectorで二重admissionできません。

## Lifecycle

vector reservation全体で1つの:

- reservation ID
- `pending` / liable / settled lifecycle
- expiry
- progressive growth cursor
- logical-operation replay identity

を持ちます。

`markLiable()` / `renew()`はvector全体へ作用します。renewはlease時間だけを変更しcapacityを増やしません。

pending expiryは全dimensionをatomicにreleaseします。liable expiryは成功済みreserved量をdimensionごとにconservative retainします。vector recovery/telemetry用に異種unitをscalar合計してはいけません。

## Settlement

全dimensionをexactly once報告します。

```ts
await lease.settle(
  [
    { key: 'requests', actualUnits: 1 },
    { key: 'tokens', actualUnits: 623 },
  ],
  'success',
);
```

各dimensionで:

```text
0 <= actualUnits <= そのdimensionで成功済みのtotal reserved units
```

unused分はそのdimensionのbudgetだけからreleaseし、全releaseとterminal stateを1 transactionでcommitします。同一settlement replayはidempotent、異なる再settlementはrejectします。

## Progressive vector growth

`VectorUsageLease.grow()`はv0.6 growth safetyをvector全体へcomposeします。1 growth attemptは:

- stable `incrementId` 1個
- reservation全体でStore-issued opaque growth cursor 1個
- 完全なdimension/budget topology
- dimensionごとの非負`additionalUnits`
- 少なくとも1 dimensionでpositive increment

を持ちます。

```ts
await lease.grow({
  incrementId: 'step-0042',
  dimensions: [
    { key: 'requests', additionalUnits: 0, budgets: [{ key: 'user:requests:day', limit: 100 }] },
    { key: 'tokens', additionalUnits: 512, budgets: [{ key: 'user:tokens:day', limit: 100_000 }] },
  ],
});
```

Storeは全incrementをatomicにadmitするか、何も増やしません。authoritative quota denialはcapacityを消費せず、cursorだけrotateしdenied replay resultを保存します。

commit後にACKが失われた場合、同じ`incrementId`・prior cursor・dimensions・limits・incrementsをexact retryします。Storeはauthoritative resultをreplayします。stale cursorでfresh IDを送るとfail closedです。`VectorUsageLease`もambiguous attemptをlocalに固定し、誤ってfresh IDで続行することを防ぎます。

settled / expired reservationはreplayを含め全growth callをrejectし、terminal後にACK recoveryが新しいmetered workを許可しないようにします。

## Provider storage compatibility

- **Memory** — scalar/vector tagged internal record。scalar behavior変更なし。
- **Redis** — existing reservation JSONへ`mode: "vector"`・dimensions・cursor/replay metadataをadditive保存。modeなし既存recordはscalarのまま。
- **Firestore** — reservation documentへoptional vector fieldをadditive保存。v0.6 scalar documentはそのままvalid。
- **Cloudflare Durable Objects** — schema v3で`reservation_vectors` sidecar tableを追加。v1/v2 scalar accounting rowはrewriteしません。

## Proof requirement

vector supportをclaimするStoreは`runVectorUsageStoreConformance()`とbackend-specific integration evidenceを通す必要があります。portable suiteはatomic denial rollback、concurrency、scalar/vector operation collision、growth replay/conflict/cursor、denied growth、pending/liable expiry、per-dimension settlement bound、growth/settle raceを検証します。

built-in Redis / Firestore / Cloudflareはprovider boundaryでcommitted vector growthのACK lossもfault injectionします。

## Non-goals

v0.7ではpricing/currency/invoice、dimension間conversion、異種unitの自動集計、ambiguous write後のoptimistic continuation、独立dimension reserveをatomicに見せる挙動は追加しません。

MCP execution patternは[Vector MCP integration](vector-mcp-integration.ja.md)を参照してください。
