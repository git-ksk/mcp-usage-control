# mcp-usage-control

Core package for concurrency-safe MCP usage enforcement. MCP and storage vendor independent.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or a a locally packed `mcp-usage-control-<version>.tgz`. See [Use from source / local tarballs](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md) / [日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md).

## English

The current core provides policy quoting, **atomic multi-budget admission**, pending -> cost-liable transitions, renewable leases, explicit settlement, scoped idempotency, provider-neutral observability hooks, reusable Store conformance support, and `MemoryUsageStore` as the process-local reference implementation.

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

A quote can apply several budgets to one invocation. Every budget reserves atomically or none does. Replay protection is scoped by `(tenantId, principal.id, tool, operationId)` and settled tombstones default to 24 hours in the reference store.

On successful `UsageControl.reserve()`, the admission result includes both the `lease` and authoritative `remainingByBudget`. Consumers should not recompute remaining capacity from configured limits. Budget keys can be application-sensitive/high-cardinality, so expose or label them only under an explicit application policy.

```ts
const admission = await control.reserve(request);
if (admission.allowed) {
  console.log(admission.remainingByBudget);
  await admission.lease.markLiable();
}
```

Pending expiry releases every participating budget. Cost-liable expiry conservatively keeps the full charge so a crash after execution starts cannot become a refund.

### Long-running `MemoryUsageStore`

`MemoryUsageStore` remains process-local, but controlled long-running single-process deployments can bound retained state:

```ts
const store = new MemoryUsageStore({
  maxRetainedOperations: 100_000,
  maxRetainedBudgetKeys: 100_000,
});
```

Capacity exhaustion raises `MemoryUsageStoreCapacityError` and fails closed instead of silently evicting accounting/replay state. `store.stats()` exposes retained-state counts. `store.retireBudgetKey(key)` explicitly retires a completed accounting-window key and rejects keys still referenced by active reservations; the application owns the decision that the window is permanently over and the key will not be reused.

See [Memory store operations](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/memory-store.md). For horizontal scale or restart durability, use a provider-backed shared Store.

`UsageControl` can receive an optional `UsageObserver` and explicit metadata. Observer delivery is best-effort, returned promises are not awaited, and observer failures can never change enforcement state. `onEvent()` itself is invoked inline, so keep synchronous work lightweight. Tool arguments and raw exception messages are not captured automatically.

For low-cardinality operational logs, `projectUsageEvent()` converts raw lifecycle events into a bounded shape that excludes identity IDs, reservation IDs, tool/budget identifiers, arbitrary outcomes, and application-defined denial text by default.

### Operational helper subpaths (v0.10)

The v0.10 operational surface is exposed through explicit subpaths so it remains separate from the authoritative Store contract:

- `mcp-usage-control/operational` — bounded process-local lifecycle snapshots, static runtime identity, and explicit scoped quota projection.
- `mcp-usage-control/settlement-outcomes` — canonical settlement vocabulary, finite alias normalization, and bounded `invalid_settlement_outcome` diagnostics.
- `mcp-usage-control/thresholds` — pure absolute/percentage remaining-threshold evaluation and above -> reached crossing detection.

These helpers never infer accounting windows, entitlement, pricing, refund eligibility, or provider health policy. See [Operational usability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/operational-usability.md).

- [Current source/tarball usage](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md)
- [Getting started](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/getting-started.md)
- [Memory store operations](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/memory-store.md)
- [Observability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/observability.md)
- [Operational usability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/operational-usability.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.md)

Authentication, payments/billing, MCP SDK integration, and provider-backed production storage belong outside this package.

## 日本語

current coreはpolicy quote、**atomic multi-budget admission**、pending -> cost-liable transition、renewable lease、explicit settlement、scoped idempotency、provider-neutral observability hook、再利用可能なStore conformance support、process-local reference implementationの `MemoryUsageStore` を提供します。

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

1 invocationへ複数budgetを適用でき、全budgetをatomicにreserveするか、どれもreserveしません。replay protectionは `(tenantId, principal.id, tool, operationId)` 単位で、reference storeのsettled tombstone defaultは24時間です。

`UsageControl.reserve()` 成功時のadmission resultには `lease` とauthoritativeな `remainingByBudget` の両方が含まれます。consumer側でconfigured limitからremainingを再計算しないでください。budget keyにはapplication-sensitive / high-cardinalityな値が含まれ得るため、公開やmetric label化は明示的なapplication policyの下でだけ行います。

```ts
const admission = await control.reserve(request);
if (admission.allowed) {
  console.log(admission.remainingByBudget);
  await admission.lease.markLiable();
}
```

pending expiryは全budgetを解放し、cost-liable expiryはexecution開始後crashがrefundにならないようfull chargeを保守的に維持します。

### `MemoryUsageStore` の長期運用

`MemoryUsageStore` はprocess-localのままですが、管理されたlong-running single-process deploymentではretained stateをbounded化できます。

```ts
const store = new MemoryUsageStore({
  maxRetainedOperations: 100_000,
  maxRetainedBudgetKeys: 100_000,
});
```

capacity exhaustion時はaccounting / replay stateをsilent evictionせず `MemoryUsageStoreCapacityError` でfail closedします。`store.stats()` でretained-state数を確認できます。`store.retireBudgetKey(key)` は終了済みaccounting-window keyを明示退役し、active reservation参照中のkeyはrejectします。windowが永久に終了し、そのkeyを同じwindowとして再利用しないという判断はapplication側が所有します。

詳しくは [Memory Storeの長期運用](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/memory-store.ja.md)。horizontal scaleやrestart durabilityが必要ならprovider-backed shared Storeを使います。

`UsageControl` へoptionalな `UsageObserver` と明示metadataを渡せます。observer deliveryはbest-effortで、返されたPromiseをawaitせず、observer failureがenforcement stateを変更することはありません。`onEvent()` 自体はinlineで呼ばれるため同期処理は軽量にしてください。tool argumentsやraw exception messageは自動収集しません。

low-cardinalityな運用logには `projectUsageEvent()` を使えます。raw lifecycle eventからidentity ID、reservation ID、tool / budget identifier、任意outcome、application定義denial textをdefaultで除外したbounded shapeへ変換します。

### Operational helper subpath (v0.10)

v0.10のoperational surfaceはauthoritative Store contractと分離した明示subpathとして公開します。

- `mcp-usage-control/operational` — bounded process-local lifecycle snapshot、static runtime identity、明示scopeしたquota projection。
- `mcp-usage-control/settlement-outcomes` — canonical settlement vocabulary、finite alias normalization、boundedな `invalid_settlement_outcome` diagnostic。
- `mcp-usage-control/thresholds` — absolute / percentage remaining threshold評価と above -> reached crossing detectionのpure helper。

これらはaccounting window、entitlement、pricing、refund可否、provider health policyを推測しません。詳しくは [Operational usability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/operational-usability.ja.md)。

- [現在のsource / tarball利用手順](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md)
- [Getting started](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/getting-started.ja.md)
- [Memory Storeの長期運用](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/memory-store.ja.md)
- [Observability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/observability.ja.md)
- [Operational usability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/operational-usability.ja.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.ja.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.ja.md)

authentication、payment / billing、MCP SDK integration、provider-backed production storageはこのpackageの責務外です。

## Atomic vector usage (v0.7)

For one logical operation that consumes unlike units, use `VectorUsagePolicy` + `VectorUsageControl` with a Store that implements optional `VectorUsageStore`. Each dimension keeps its own units and hierarchical budgets; unlike units are never summed. Vector admission, progressive growth, expiry/recovery, and settlement are atomic across the complete dimension set.

Store authors can validate the optional capability with `runVectorUsageStoreConformance()` from `mcp-usage-control/conformance`.

## Operation reconciliation (v0.8)

`OperationReconciliationStore` is the optional scalar read capability, and v0.13 adds the parallel `VectorOperationReconciliationStore` capability for initial vector-reserve acknowledgement ambiguity. `MemoryUsageStore` implements both. The conformance subpath exports scalar and vector reconciliation conformance helpers for third-party Stores. Unknown or unprovable state rejects and remains fail closed; reconciliation never authorizes business replay. Cloudflare remains an explicit scalar-only remote reconciliation exception. See [Operation reconciliation/status](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/operation-reconciliation.md).
