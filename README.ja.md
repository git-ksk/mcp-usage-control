# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行向けの、同時実行に強いusage enforcement runtimeです。**

> Status: pre-alpha。APIとpackage名はまだstableではありません。workspace packageはまだnpmへpublishしていません。

`mcp-usage-control` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するprovider-neutral runtimeです。

決済、MCP Gateway、OAuth provider、一般的なrate limiter自体を目的にはしていません。agentのretry、parallel tool call、timeout、長時間実行、upstream cost発生後のfailureでもusage accountingを壊さないことを主目的にしています。

## 基本ライフサイクル

```text
principal -> policy/entitlement -> quote -> atomic reserve -> execute -> settle
                                                ^              |
                                                |--- renew -----|
```

重要なのは、failure時に自動rollbackするのではなく**settlementで実消費量を確定する**ことです。toolが失敗しても、その前に外部API、DB、compute resourceのcostが発生している場合があります。

reservationはrenew可能なleaseです。MCP adapterはhandler実行中にactive leaseをheartbeatし、正常な長時間toolを初回TTL超過だけでabandoned扱いしないようにします。

## 現在のpackage

- `@mcp-usage-control/core`
  - principal単位のadmission
  - policy-driven credit quote
  - pre-execution reservation
  - renewable lease
  - outcome-aware settlement
  - duplicate operation protection
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - `@modelcontextprotocol/server` v2 adapter
  - lease heartbeatを既定で有効化
  - error時はfull reservationを使う保守的な既定値
  - actual-cost classification hook
  - ambiguous settlement failureを盲目的にretryしない
- `@mcp-usage-control/redis`
  - Luaによるatomic reserve / renew / settle
  - bounded expiry / idempotency cleanup
  - budget / operation identifierをhash化
  - Redis Cluster-compatibleなsingle hash-slot transaction domain
  - CIで実Redis integration testを実施

pre-alpha中はpackage名とpublic contractを確定してからregistry releaseするため、workspace packageを `private: true` のまま維持します。

## ドキュメント

- **最初に読む:** [Getting started](docs/getting-started.ja.md)
- **MCP SDK v2へ組み込む:** [MCP integration](docs/mcp-integration.ja.md)
- **設計・invariant:** [Architecture](docs/architecture.ja.md)
- **Production storage:** [Redis adapter](docs/redis.ja.md)
- **Release互換性:** [Release policy](docs/releasing.ja.md)
- **一覧:** [Documentation index](docs/README.ja.md)

Project policy: [Contributing](CONTRIBUTING.ja.md) · [Security](SECURITY.ja.md) · [Support](SUPPORT.ja.md) · [Code of Conduct](CODE_OF_CONDUCT.ja.md)

## SourceからのQuick start

packageはまだpublishしていないため、現時点ではrepositoryをcloneしてworkspaceを実行します。

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

Node.js 20+とpnpm 10が必要です。CIではNode.js 20 / 22と実Redis 7 integration testを実行します。

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

MCP tool handlerでは `protectTool()` が実行前にreserveし、handler実行中はleaseをrenewし、完了後にsettleします。未分類exceptionはfull reservationを課金し、metered resourceが消費されていないことを証明できる場合だけ小さいerror costを返してください。

production Redis storage:

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisUsageStore(redis);
```

key model、cleanup、failure semantics、Redis Cluster trade-offは [Redis adapter](docs/redis.ja.md) を確認してください。

## Safety invariant

1. quota checkとreservationは1つのstore operationとして扱い、`check -> execute -> record`へ分離しない。
2. 同一principal / operation IDで2つのactive reservationを作らない。
3. 長時間実行中のactive reservationはrenewし、初回TTLだけを理由に回収しない。
4. 現在のv0.1 modelでは `actualUnits` はreserved amountを超えない。
5. 同一settlement replayはidempotent、conflicting settlementはfailする。
6. abandonedなexpired reservationはin-flight unitsをreleaseする。
7. applicationが明示分類しないerrorは保守的に課金する。
8. ambiguous settlement failureを表面化させ、盲目的にretryしない。
9. storage failureを新規admissionのallow判定へ変換しない。

full design boundaryとdistributed leaseの制約は [Architecture](docs/architecture.ja.md) を参照してください。

## Planned v0.1

- daily + monthly + tenantなどのatomic multi-budget admission
- operation tombstone / expiry semanticsの確定
- observability hook
- package名とnpm release workflow

Billing provider、OAuth provider、dashboard、payment protocolはcoreの責務外です。OpenMeter、Unkey、Stripe、RevenueCat、x402などはruntime dependencyではなくintegration candidateとして扱います。

## Contributing

contributionを歓迎します。reservation、retry、expiry、settlement behaviorの変更はcorrectness / security sensitiveなので、対応するconcurrency / failure testを追加してください。詳しくは [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください。

quota bypass、double spending、cross-tenant leakage、replay abuse、inconsistent settlementにつながるvulnerabilityはpublic Issueへ投稿せず [SECURITY.ja.md](SECURITY.ja.md) に従ってください。

## License

Apache-2.0