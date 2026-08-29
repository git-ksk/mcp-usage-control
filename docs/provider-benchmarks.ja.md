# Provider benchmark / cost-profile harness

[English](provider-benchmarks.md) | [日本語](provider-benchmarks.ja.md)

`mcp-usage-control` のcorrectness / conformance testは **Storeがaccounting invariantを守るか** を検証します。benchmark harnessは別の問い、**同じcontractをこのexact environmentで動かしたときのlatency / contention shape** を測ります。速いproviderでもatomic admission、liability、replay、expiry、settlement semanticsを弱めることはありません。

## Harnessを実行する

最初にbuildし、providerを選びます。

```console
pnpm build
MUC_BENCH_ITERATIONS=100 MUC_BENCH_CONCURRENCY=8 pnpm benchmark:memory
REDIS_URL=redis://127.0.0.1:6379 pnpm benchmark:redis
```

Firestoreはproduction接続を意図的に拒否し、Local Emulator Suiteを必須にします。

```console
GCLOUD_PROJECT=demo-muc-firestore-benchmark \
  pnpm dlx firebase-tools@15.24.0 emulators:exec \
  --only firestore \
  --project demo-muc-firestore-benchmark \
  "MUC_BENCH_ITERATIONS=50 node scripts/benchmark-usage-store.mjs firestore"
```

Cloudflareはrepositoryのlocal workerd configを起動し、localhost gatewayを測ります。

```console
MCP_USAGE_CLOUDFLARE_TOKEN=local-integration-token \
  pnpm dlx wrangler@4.114.0 dev --local \
  --config packages/cloudflare/wrangler.test.jsonc \
  --port 8799

MCP_USAGE_CLOUDFLARE_TOKEN=local-integration-token \
  MUC_BENCH_ITERATIONS=100 \
  pnpm benchmark:cloudflare
```

outputはJSONで、timestamp、Node/platform、provider target、iteration/concurrency、success/error count、p50/p95/p99/min/max latencyを含みます。

## Coverage

version-1 harnessは次を測定します。

- scalar reserve allow / quota deny
- 3-budget atomic reserve
- `markLiable` / `renew` / settlement
- progressive reservation growth
- vector reserve / grow / settle
- providerが公開する場合のactive scalar reconciliation
- 1 shared hot budgetへのconcurrent admission。expected accepted/denied countもassert
- adapterがexplicit operationを公開する場合のbounded recovery（現在はFirestore）

settlement等のlifecycle operationではsetup reserveをtimed section外に置き、setupを含むend-to-end時間ではなくnamed Store transitionを測ります。

## Deployed measurementのsafety boundary

harnessはsafe-by-defaultです。

- Firestoreは `FIRESTORE_EMULATOR_HOST` 必須でproduction Firestoreをtargetできない。
- localhost以外のRedis / Cloudflareは `MUC_BENCH_ALLOW_REMOTE=1` が必須。
- remote Cloudflareはadapter本来のHTTPS ruleも維持し、benchmark用に弱めない。
- runごとにrandomなbenchmark namespace/domain identityを使う。
- shared production accounting domainやreal user/shared quotaをbenchmark目的で消費しない。

remoteで測る場合はdisposable benchmark environmentを明示的に用意し、`MUC_BENCH_ALLOW_REMOTE=1`、region/runtime/provider configを記録し、終了後はprovider lifecycle ruleに従ってtest domainをretire/deleteします。

## Provider cost / amplificationの読み方

以下はoperation shapeでありuniversal priceではありません。provider pricingは独立に変わるため、current pricingと実測workloadから見積もります。

| Store | Rough authoritative operation shape |
| --- | --- |
| Memory | process-local map/state transition。reference semanticsのみ |
| Redis | Store lifecycle methodごとにserver-side Lua/EVAL transition 1回。全participating budgetはconfigured Redis Cluster hash slotを共有 |
| Firestore | reserveはreservation + `N` budget documentをreadし、成功時reservation + `N` budgetをwrite。`markLiable` / `renew` はreservation、settlement/recoveryは必要なreservation/budget documentをtransactionalに処理 |
| Cloudflare remote DO | remote Store operationごとにauthenticated HTTP request 1回で1 Durable Object accounting domainへ到達。SQLite statement数はpublic contract外のimplementation detail |

そのためFirestoreの3-budget admissionは1-budgetよりtransaction participant / database operationが増えます。shared/hot budgetは共通transaction participantになるのでcontention/retry latencyがraw uncontended latencyを支配する場合があります。Redis / Durable Objectsも別の形でatomicityをcentralizeするため、実際に採用するdeployment topologyで測ります。

## Initial local baseline

versioned raw resultは [`docs/benchmarks/`](benchmarks/) に保存します。2026-08-29の初回4 baselineは **SLO / provider rankingではなくsmoke baseline** です。

4 providerすべてNode.js 22.23.2 / Linux arm64 containerで実行しました。Memoryはprocess-local、Redisはlocal Redis 7 container、FirestoreはLocal Emulator Suite、Cloudflareは同じisolated Node 22環境内のlocal workerdを利用しています。

Firestore smoke runではshared hot-budget contentionがuncontended operationより桁違いに遅くなり得ることを確認できました。この数値をproduction estimateへ転用せず、実際のregion / concurrency / topologyに近いdisposable test environmentで再実行してください。

## Regression policy

performanceは意図的に**non-blocking CI evidence**です。correctness / conformanceはblockingのままです。Store script/transaction、cleanup、serialization、transport、contention behaviorがmaterialに変わるreleaseでは再測定します。同じpinned environmentでrepeatableなmaterial regressionがあれば調査しますが、noisyなwall-clock thresholdをnormal PR CI gateにはしません。
