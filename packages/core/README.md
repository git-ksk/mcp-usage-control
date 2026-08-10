# mcp-usage-control

Core package for concurrency-safe MCP usage enforcement. MCP and storage vendor independent.

```console
npm install mcp-usage-control
```

## English

The v0.1 core provides policy quoting, **atomic multi-budget admission**, pending -> cost-liable transitions, renewable leases, explicit settlement, scoped idempotency, and `MemoryUsageStore` as the reference implementation.

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

A quote can apply several budgets to one invocation. Every budget reserves atomically or none does. Replay protection is scoped by `(tenantId, principal.id, tool, operationId)` and settled tombstones default to 24 hours in the reference store.

Pending expiry releases every participating budget. Cost-liable expiry conservatively keeps the full charge so a crash after execution starts cannot become a refund.

- [Getting started](../../docs/getting-started.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

Authentication, payments/billing, MCP SDK integration, and production storage belong outside this package.

## 日本語

v0.1 coreはpolicy quote、**atomic multi-budget admission**、pending -> cost-liable transition、renewable lease、explicit settlement、scoped idempotency、reference implementationの `MemoryUsageStore` を提供します。

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

1 invocationへ複数budgetを適用でき、全budgetをatomicにreserveするか、どれもreserveしません。replay protectionは `(tenantId, principal.id, tool, operationId)` 単位で、reference storeのsettled tombstone defaultは24時間です。

pending expiryは全budgetを解放し、cost-liable expiryはexecution開始後crashがrefundにならないようfull chargeを保守的に維持します。

- [Getting started](../../docs/getting-started.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

authentication、payment / billing、MCP SDK integration、production storageはこのpackageの責務外です。
