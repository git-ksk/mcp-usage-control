# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

`mcp-usage-control` は現在pre-alphaで、workspace packageは意図的にprivateです。そのためnpm installではなくrepository sourceから開始します。

## Requirements

- Node.js 20以上
- pnpm 10
- Redis integration testまたはRedis adapter利用時のみRedis 7

## Clone and verify

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

`pnpm check` は全workspace packageをbuildしてtestします。CIではNode.js 20 / 22、実Redis 7、公式MCP SDK v2 client/handler integration pathまで実行します。

> reproducible release installはまだ未確定です。v0.1前に `pnpm-lock.yaml` をcommitし、CIをfrozen installへ切り替えます。

## Mental model

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                 ^                          |
                                 |----------- renew --------|
```

policyがeligibilityと最大reserve unitsを決定し、storeがquota比較とreservation作成をatomicに行います。

reservationは最初pendingです。metered execution開始直前に `markLiable()` を呼びます。pending expiryはcapacityを解放できますが、cost-liable expiryはfull reservationを維持するため、execution開始後のworker/process crashがrefundになりません。

tool failureは自動的にfreeではありません。upstream workがmetered resourceを消費した場合、そのcostをsettleする必要があります。

## Minimal core example

```ts
import {
  MemoryUsageStore,
  UsageControl,
  type UsagePolicy,
} from '@mcp-usage-control/core';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budget: {
        key: `month:${request.principal.id}:2026-08`,
        limit: request.principal.plan === 'pro' ? 2_000 : 100,
      },
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
const admission = await control.reserve({
  operationId: 'request-123',
  principal: { id: 'user-42', plan: 'free' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) throw new Error('usage denied');

await admission.lease.markLiable();
try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  // actual incurred costをsettleします。metered resource未消費を
  // 証明できる場合だけ0を使います。
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

in-memory storeはtest / local development向けです。

## Production Redis store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
const control = new UsageControl(store, policy);
```

window-qualified budget keyを使います。

```text
month:user-42:2026-08
day:user-42:2026-08-10
```

adapterはreset dateを推測しません。lease時刻はRedis server timeから取得します。production利用前に [Redis adapter](redis.ja.md) のpersistence / failover durabilityとlazy cleanup behaviorも確認してください。

## MCP tool handler

`@modelcontextprotocol/server` v2の **single-round** toolでは `protectTool()` を使うと、reserve、`markLiable`、heartbeat、MCP result classification、classifier fallback、settlementをhandler boundaryへまとめられます。詳しくは [MCP integration](mcp-integration.ja.md) を参照してください。

MCP v2 `input_required` multi-round toolはまだ `protectTool()` 未対応です。suspend/resume accounting実装まではproductionでwrapしないでください。

## Production利用前

現在はpre-alphaです。特に次を考慮してください。

- package名 / public APIは未安定。
- 1 reservationは現在1 budgetのみ。
- atomic multi-budget admissionはv0.1前に予定。
- operationのprincipal / tenant scopeは確定作業中。
- `input_required` multi-round accountingは未実装。
- lease loss後のprovider-specific fencingはgeneric core外。
- Redis atomicityだけではpersistence / failover durabilityを保証しない。
- authentication / principal derivationはapplication責務。

production enforcementへ使う前に [Architecture](architecture.ja.md)、[Security policy](../SECURITY.ja.md)、[Redis adapter](redis.ja.md) を確認してください。