# Cloudflare Durable Objects adapter — current source

[English](cloudflare.md) | [日本語](cloudflare.ja.md)

`mcp-usage-control-cloudflare` はSQLite-backed Cloudflare Durable Objectでcore `UsageStore` contractを実装します。

> **現在の配布状況:** packageはまだnpm未公開です。[Source / local tarballから使う](using-from-source.ja.md) の手順を利用してください。

## Durable Objectsを使う理由

usage admissionはread-modify-write transactionです。参加する全budgetを許可できる場合だけ全budgetを更新する必要があります。そのため1 Durable Objectを1 atomic transaction domainとして扱い、同期SQLite transaction内でstate transitionを行います。

accounting pathにWorkers KVは使いません。

## Components

packageは次を提供します。

- `CloudflareUsageStore` — Durable Object namespace bindingを直接使うWorker-local `UsageStore`。
- `RemoteCloudflareUsageStore` — Cloudflare外のapplication向けHTTP client。
- `createCloudflareUsageStoreGateway()` — remote client向けauthenticated Worker handler。
- `mcp-usage-control-cloudflare/worker` → `UsageControlDurableObject` — SQLite Durable Object実装。

coreはCloudflareへ依存しません。

## Transaction domain

1つのconfigured `domainName` が1つのDurable Object instanceへ対応します。1 reservationの全budgetを同じobject内でcheck / updateします。

Redis adapterのsingle transaction-domain ruleと同じ考え方です。horizontal write distributionよりcorrectnessを優先します。global domainが非常にhotになるとbottleneckになり得るため、atomic reservationがpartitionをまたがない場合だけ独立usage domainへ分割してください。

## Worker-local setup

Worker entry pointからDurable Object classをexportします。

```ts
export { UsageControlDurableObject } from 'mcp-usage-control-cloudflare/worker';
```

namespace bindingからstoreを作ります。

```ts
import { CloudflareUsageStore } from 'mcp-usage-control-cloudflare';

const store = new CloudflareUsageStore(env.USAGE_CONTROL, {
  domainName: 'production',
});
```

現在のWranglerではSQLite-backed Durable Object classをbindingできます。Worker export / configuration上のclass名・binding名を一致させてください。

## Cloudflare外 / GCPから利用

Durable Object namespace bindingはWorker-localです。GCP上のMCP server等から使う場合は、小さいWorker gatewayをdeployし、application側では `RemoteCloudflareUsageStore` を利用します。

Worker側:

```ts
import { createCloudflareUsageStoreGateway } from 'mcp-usage-control-cloudflare';

const usageHandler = createCloudflareUsageStoreGateway({
  namespace: env.USAGE_CONTROL,
  domainName: 'monokura-dogfood',
  authorize: request => {
    return request.headers.get('authorization') === `Bearer ${env.USAGE_GATEWAY_TOKEN}`;
  },
});
```

Application側:

```ts
import { RemoteCloudflareUsageStore } from 'mcp-usage-control-cloudflare';

const store = new RemoteCloudflareUsageStore({
  endpoint: process.env.MCP_USAGE_CLOUDFLARE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_TOKEN!}`,
  }),
});
```

上のBearer tokenはinterface説明用の単純例です。productionではCloudflare Access service token等、applicationが管理するauth mechanismを利用できます。credentialをsource control / telemetryへ出さないでください。

gatewayにはunauthenticated defaultを用意していません。`authorize(request)` callbackが必須です。

## Remote ACK ambiguity

remote clientはstore operationごとにHTTP requestを1回だけ送り、timeout / network failureを**自動retryしません**。

timeout時は次のどちらかを区別できません。

- Durable Objectがwriteを適用していない。
- writeはcommit済みでresponseだけ失われた。

reserveでは、同じlogical operationを後からretryすると通常の `(tenantId, principal.id, tool, operationId)` identityで保護され、最初のwriteがcommit済みなら `duplicate_operation` になり得ます。

settlementはtombstone retention中、identical replayがidempotentです。異なるsettlement replayはrejectします。

ambiguous failureをgeneric automatic retry middlewareで隠さないでください。

## Privacy boundary

Cloudflare backendへ渡すのはenforcement state transitionに必要なaccounting dataだけです。

- logical operation tupleのSHA-256 hash。
- budget keyのSHA-256 hash。
- quoted / actual unit countとbudget limit。
- TTL / retention duration。
- settlement outcomeのSHA-256 hash。
- opaque reservation state。

このadapterはraw principal ID、tenant ID、tool名、operation ID、budget key、tool argumentsをCloudflare backendへ送りません。

hashingはencryptionではありません。identifierはnon-secretとし、token / credential / sensitive payloadを埋め込まないでください。

## Lifecycle

backendはcore lifecycleを維持します。

```text
pending -> liable -> settled
```

- `reserve`: 全budgetをatomicにreserveするか、どれも変更しない。
- `markLiable`: metered execution boundaryへ入ったことを記録。
- `renew`: activeなpending / liable leaseを延長。
- `settle`: 全budgetからunused unitsをreleaseし、bounded replay tombstoneを作る。
- pending expiry: reservation全体をrelease。
- liable expiry: full reservationを保守的に維持しtombstoneを作る。

metered work開始前にusage未発生を証明できるapplication向けに、pending状態からの明示settlementも許可します。

## Cleanup / cost behavior

通常のreservation / tombstone cleanup用にDurable Object alarmはscheduleしません。expired stateは後続admission時にlazy / bounded batchでrecoveryし、直接指定されたexpired reservationはその操作時に回収します。

利点:

- cleanupだけのためのperiodic background requestがない。
- lease renewalごとのalarm writeがない。
- idle usage domainはidleのままにできる。

trade-off:

- expired backlogが多い場合、十分な後続admissionがcleanupするまでpending capacity recoveryが遅れる可能性がある。
- expired settled tombstoneがlogical retentionより長くphysical storageへ残る場合がある。

quota enforcementとしては保守的ですが、crash / abandonment量が多いworkloadではmonitorしてください。

## Budget window retention

Redis adapterと同様、daily / monthly reset semanticsをadapterが推測しません。windowをbudget keyへ含めてください。

backendへ保存する前にbudget keyをhash化します。applicationのaccounting windowをgeneric adapterでは判断できないため、positiveなhistorical budget rowを自動削除しません。

長期運用ではhistorical rowが問題になる前にapplicationのwindow lifecycleに合うretention / reconciliationを定義してください。

## Observability

runtime lifecycleとbackend recovery eventの両方が必要なら `UsageControl` とCloudflare storeへ同じobserverを渡します。

Cloudflare recovery eventは `store: 'cloudflare'` で、次を通知できます。

- lazy cleanupでreleaseしたpending件数 / unitsのaggregate。
- liable-retained件数 / unitsのaggregate。
- 直接指定されたexpired reservationをrecoveryした場合のopaque hashed reservation ID。

observer failureはenforcement結果へ影響しません。unique reservation / operation / principal identifierをmetric labelへ使わないでください。

詳細は [Observability](observability.ja.md) を参照してください。

## Local verification

repositoryにはCloudflare専用integration workflowがあります。packageをbuildし、Wrangler local mode（workerd）を起動して実際のWorker gateway + SQLite Durable Object pathを検証します。

coverする内容:

- remaining 1 unitに対する100並列競合。
- duplicate operation block。
- settlement replay / conflict。
- pending / liable expiry。
- long-running workのlease renewal。
- lost reserve ACK。
- lost settlement ACK reconciliation。
- gateway authentication。
- observer failure isolation。

## Operation reconciliation (v0.8)

`mcp-usage-control-cloudflare/reconciliation` はv0.8の共通scalar operation-status語彙を採用します。`reconcileRemoteCloudflareOperation()` がgeneric read-only entry pointで、既存 `reconcileRemoteCloudflareReserve()` はv0.7互換aliasとして維持します。authenticated lookupは追加reservation、release、renew、settleを行いません。

詳しいfail-closed semanticsは [Operation reconciliation / status](operation-reconciliation.ja.md) と [Cloudflare reserve ACK reconciliation](cloudflare-reserve-reconciliation.ja.md) を参照してください。

## Current limitations

- core v0.1と同様、1 reservationの全budgetは同じquoted / actual unit countを利用。
- configured transaction domain 1つを1 Durable Object instanceがserialize。
- cleanupはlazy / bounded。
- historical used-budget row retentionはapplication-specific。
- remote gatewayのauthentication / credential rotationはapplication責務。
- enforcement stateはfinancial-grade accounting ledgerではない。
- MCP multi-round `input_required` は引き続きv0.1 `protectTool()` の対象外。

## Atomic heterogeneous vector usage (v0.7 / schema v3)

`CloudflareUsageStore` / `RemoteCloudflareUsageStore`はoptional `VectorUsageStore`を実装します。base `reservations` rowはshared operation/lifecycle identityとして維持し、schema v3ではvector専用metadataをadditive `reservation_vectors` sidecar tableへ保存します。existing v1/v2 scalar accounting rowはrewriteしません。

Durable Object `transactionSync`が全vector dimension/budget変更とreservation/vector metadataを1 atomic boundaryで処理します。vector HTTP methodはprotocol v1へのadditive method（`reserve_vector` / `grow_vector` / `settle_vector`）です。local workerd CIではportable vector conformanceとremote committed-vector-growth ACK-loss replayも実行します。
