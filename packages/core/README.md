# mcp-usage-control

Core package for concurrency-safe MCP usage enforcement. MCP and storage vendor independent.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or a locally packed `mcp-usage-control-0.2.0.tgz`. See [Use from source / local tarballs](../../docs/using-from-source.md) / [日本語](../../docs/using-from-source.ja.md).

## English

The v0.2 core provides policy quoting, **atomic multi-budget admission**, pending -> cost-liable transitions, renewable leases, explicit settlement, scoped idempotency, provider-neutral observability hooks, and `MemoryUsageStore` as the reference implementation.

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

A quote can apply several budgets to one invocation. Every budget reserves atomically or none does. Replay protection is scoped by `(tenantId, principal.id, tool, operationId)` and settled tombstones default to 24 hours in the reference store.

On successful `UsageControl.reserve()`, the admission result includes both the `lease` and `remainingByBudget`. These remaining values are copied directly from the authoritative store result; consumers should not recompute them from configured limits. Budget keys can be application-sensitive/high-cardinality, so expose or label them only under an explicit application policy.

```ts
const admission = await control.reserve(request);
if (admission.allowed) {
  console.log(admission.remainingByBudget);
  await admission.lease.markLiable();
}
```

Pending expiry releases every participating budget. Cost-liable expiry conservatively keeps the full charge so a crash after execution starts cannot become a refund.

`UsageControl` can receive an optional `UsageObserver` and explicit metadata. Observer delivery is best-effort, returned promises are not awaited, and observer failures can never change enforcement state. `onEvent()` itself is invoked inline, so keep synchronous work lightweight. Tool arguments and raw exception messages are not captured automatically.

For low-cardinality operational logs, `projectUsageEvent()` converts raw lifecycle events into a bounded shape that excludes identity IDs, reservation IDs, tool/budget identifiers, arbitrary outcomes, and application-defined denial text by default.

- [Current source/tarball usage](../../docs/using-from-source.md)
- [Getting started](../../docs/getting-started.md)
- [Observability](../../docs/observability.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

Authentication, payments/billing, MCP SDK integration, and production storage belong outside this package.

## 日本語

v0.2 coreはpolicy quote、**atomic multi-budget admission**、pending -> cost-liable transition、renewable lease、explicit settlement、scoped idempotency、provider-neutral observability hook、reference implementationの `MemoryUsageStore` を提供します。

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

1 invocationへ複数budgetを適用でき、全budgetをatomicにreserveするか、どれもreserveしません。replay protectionは `(tenantId, principal.id, tool, operationId)` 単位で、reference storeのsettled tombstone defaultは24時間です。

`UsageControl.reserve()` 成功時のadmission resultには `lease` と `remainingByBudget` の両方が含まれます。remaining値はauthoritative store resultからそのままcopyされるため、consumer側でconfigured limitから再計算しないでください。budget keyにはapplication-sensitive / high-cardinalityな値が含まれ得るため、公開やmetric label化は明示的なapplication policyの下でだけ行います。

```ts
const admission = await control.reserve(request);
if (admission.allowed) {
  console.log(admission.remainingByBudget);
  await admission.lease.markLiable();
}
```

pending expiryは全budgetを解放し、cost-liable expiryはexecution開始後crashがrefundにならないようfull chargeを保守的に維持します。

`UsageControl` へoptionalな `UsageObserver` と明示metadataを渡せます。observer deliveryはbest-effortで、返されたPromiseをawaitせず、observer failureがenforcement stateを変更することはありません。`onEvent()` 自体はinlineで呼ばれるため同期処理は軽量にしてください。tool argumentsやraw exception messageは自動収集しません。

low-cardinalityな運用logには `projectUsageEvent()` を使えます。raw lifecycle eventからidentity ID、reservation ID、tool / budget identifier、任意outcome、application定義denial textをdefaultで除外したbounded shapeへ変換します。

- [現在のsource / tarball利用手順](../../docs/using-from-source.ja.md)
- [Getting started](../../docs/getting-started.ja.md)
- [Observability](../../docs/observability.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

authentication、payment / billing、MCP SDK integration、production storageはこのpackageの責務外です。
