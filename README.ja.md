# mcp-usage-control

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行向けの、同時実行に強いusage enforcement runtimeです。**

> Status: pre-alpha。APIとpackage名はまだ固定していません。workspace packageは意図的にnpm未公開です。

`mcp-usage-control` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するprovider-neutralなruntimeです。

payment processor、MCP Gateway、OAuth provider、一般的なrate limiter自体を目的にはしていません。agentのretry、parallel tool call、timeout、長時間実行、upstream cost発生後のfailure、settlement前のprocess消失でもusage accountingを壊さないことを狙います。

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                ^                          |
                                                |----------- renew --------|
```

重要なのはautomatic rollbackではなく **settlement** です。toolが失敗しても、その前に外部API・DB・compute resourceを消費している場合があります。

reservationは最初pendingです。metered execution boundaryへ入る直前にcost-liableへ遷移します。pending leaseが実行前にexpireした場合はcapacityを解放できますが、cost-liable leaseが実行開始後にexpireした場合はfull reservationを保守的に消費済みとして維持します。これによりupstream work後のprocess crashがrefundになることを防ぎます。

## 現在のpackage

- `@mcp-usage-control/core`
  - policy-driven credit quote / principal-scoped admission
  - atomic reservation contract
  - pending -> cost-liable transition
  - renewable lease
  - outcome-aware settlement
  - duplicate operation protection
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - `@modelcontextprotocol/server` v2 **single-round** tool handler adapter
  - handler entry前にleaseをcost-liable化
  - automatic lease heartbeat
  - normal success / MCP `isError: true` / thrown errorを区別
  - classifier失敗時はfull reservationを保守的にcharge
  - ambiguous settlement failureをblind retryしない
  - MCP v2 `input_required` はsuspend/resume accounting実装まで明示的に未対応
- `@mcp-usage-control/redis`
  - Luaによるatomic reserve / mark-liable / renew / settle
  - Redis server timeによるlease判定。application clock skew非依存
  - state-dependent expiry recovery
  - bounded expiry / idempotency cleanup
  - operation IDをcollision-safe tuple encodeしてからhash化
  - Redis Clusterで同一hash-slotに収まるtransaction domain
  - CIで実Redis integration test

pre-alpha中はpackage名とpublic contract確定前の誤publishを防ぐため、workspace packageを `private: true` にしています。

## Documentation

- **はじめに:** [Getting started](docs/getting-started.ja.md)
- **MCP SDK v2 integration:** [MCP integration](docs/mcp-integration.ja.md)
- **設計とinvariant:** [Architecture](docs/architecture.ja.md)
- **Production storage:** [Redis adapter](docs/redis.ja.md)
- **API:** [API reference](docs/api-reference.ja.md)
- **Release policy:** [Release policy](docs/releasing.ja.md)
- **一覧:** [Documentation index](docs/README.ja.md)

Project policy: [Contributing](CONTRIBUTING.ja.md) · [Security](SECURITY.ja.md) · [Support](SUPPORT.ja.md) · [Code of Conduct](CODE_OF_CONDUCT.ja.md)

## Sourceから確認

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

Node.js 20+ / pnpm 10が必要です。CIではNode.js 20 / 22、実Redis 7、公式MCP SDKのClient/handler integration pathまでtestします。

## Example

```ts
const control = new UsageControl(
  new MemoryUsageStore(),
  {
    quote(request) {
      return {
        decision: 'allow',
        units: request.tool === 'full_export' ? 5 : 1,
        budget: {
          key: `month:${request.principal.id}:2026-08`,
          limit: request.principal.plan === 'pro' ? 2000 : 100,
        },
      };
    },
  },
);
```

MCP single-round tool handlerでは `protectTool()` がreserve、cost-liable化、handler実行中のrenew、result classification、settlementまでを扱います。未分類errorやclassifier failureは保守的にchargeします。

Production Redis:

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
```

production利用前に [Redis adapter](docs/redis.ja.md) を確認してください。Lua atomicityだけではpersistence / failover durabilityは保証されません。必要なaccounting guaranteeに合わせてRedis HA / persistenceを選定します。

## Safety invariants

1. quota比較とreservation作成は1 store operationです。`check -> execute -> record` にはしません。
2. 同じprincipal / operation IDはreplay protection期間中に2つのreservationを取得できません。
3. metered execution boundaryへ入る時点でleaseをcost-liableへ遷移します。
4. expired pending reservationはcapacityを解放し、expired cost-liable reservationはfull chargeを維持します。
5. active long-running leaseはrenew可能です。
6. 現行modelでは `actualUnits <= reservedUnits` が必要です。
7. 同じsettlement replayはidempotent、異なるsettlementはerrorです。
8. MCP `isError: true` resultをsuccessとして扱いません。
9. cost-classification failureではfull reservationをsettleしてからerrorを表面化します。
10. ambiguous settlement failureは表面化し、blind retryしません。
11. storage failureを新規admissionのallowへ変換しません。
12. Redis lease時刻はapplication hostではなくRedisから取得します。

詳しくは [Architecture](docs/architecture.ja.md) を参照してください。

## 現在の重要な制約: `input_required`

MCP v2 multi-round `input_required` flowではfresh request間でreservationをsuspend/resumeするsemanticsが必要です。現在の `protectTool()` は、roundごとのsilent課金やduplicate operation deadlockを避けるため明示的にrejectします。dedicated supportが入るまでproductionの `input_required` toolにはwrapしないでください。

## v0.1予定

- daily + monthly + tenant等のatomic multi-budget admission
- operation tombstone / principal-tenant scope semanticsの確定
- MCP `input_required` suspend/resume accounting、または意図的に確定したsupport boundary
- observability hook
- `pnpm-lock.yaml` commit、frozen CI、package pack test、npm release workflow

OpenMeter、Unkey、Stripe、RevenueCat、x402等はcore dependencyではなくintegration candidateとして扱います。

## Contributing

reservation、liability、retry、expiry、settlement behaviorの変更はcorrectness / security sensitiveです。対応するconcurrency / failure testを含めてください。詳しくは [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

quota bypass、double spending、cross-tenant leakage、replay abuse、inconsistent settlementにつながる脆弱性はpublic Issueにせず [SECURITY.ja.md](SECURITY.ja.md) に従ってください。

## License

Apache-2.0