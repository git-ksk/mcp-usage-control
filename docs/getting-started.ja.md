# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

`mcp-usage-control` は現在pre-alphaで、workspace packageは意図的にprivateにしています。そのため、このguideはnpm installではなくrepository sourceから始めます。

## 必要環境

- Node.js 20以上
- pnpm 10
- Redis integration testを実行する場合、またはRedis adapterを利用する場合はRedis 7

## Cloneして確認

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

`pnpm check` はworkspace packageをbuildし、testを実行します。CIではNode.js 20 / 22を対象にし、Redis integration testでは実際のRedis 7 serviceを起動します。

## 基本モデル

coreの流れは次のとおりです。

```text
principal -> policy -> quote -> atomic reserve -> execute -> settle
                                 ^              |
                                 |--- renew -----|
```

policyがrequestを許可するか、何unitをreserveするかを決めます。storeはquota比較とreservation作成をatomicに実行します。成功したreservationはrenew可能なleaseになり、実行後に実消費量をsettleします。

toolが失敗しても自動的に無料にはしません。すでにupstream resourceを消費している場合、そのcostをsettlementへ反映する必要があります。

## 最小のin-memory例

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

if (!admission.allowed) {
  throw new Error(`Usage denied: ${admission.reason}`);
}

try {
  // ここでmetered workを実行します。
  await admission.lease.settle(1, 'success');
} catch (error) {
  // executionとsettlementをapplication側で分離する場合は、metered workが
  // 実際に発生したかに基づいてactual unitsを分類してください。
  throw error;
}
```

in-memory storeはtest / local development向けです。productionでは [Architecture](architecture.ja.md) に記載したatomicityとfailure semanticsを満たすstoreを利用してください。

## Production Redis store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisUsageStore(redis);
const control = new UsageControl(store, policy);
```

accounting windowが明示されるよう、budget keyにはwindowを含めます。

```text
month:user-42:2026-08
day:user-42:2026-08-10
```

adapter側でbudgetのreset日を推測しません。production利用前に [Redis adapter](redis.ja.md) を確認してください。

## MCP tool handler

`@modelcontextprotocol/server` v2では `protectTool()` を使うことで、reserve、lease heartbeat、error classification、settlementをhandler boundaryへまとめられます。詳しくは [MCP integration](mcp-integration.ja.md) を参照してください。

## Production利用前の注意

このrepositoryはまだpre-alphaです。特に次の点に注意してください。

- package名とpublic APIはまだstableではありません。
- 現在は1 reservationにつき1 budgetです。
- atomic multi-budget admissionはv0.1までの予定です。
- lease loss後の厳密なprovider-specific fencingはgeneric coreの責務外です。
- authenticationとprincipal derivationはapplication側の責務です。

実際のenforcement pathへ導入する前に [Architecture](architecture.ja.md)、[Security policy](../SECURITY.ja.md)、[Redis adapter](redis.ja.md) を確認してください。