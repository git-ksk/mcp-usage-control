# Cloudflare exact post-reserve retry

[English](cloudflare-exact-retry.md) | [日本語](cloudflare-exact-retry.ja.md)

`mcp-usage-control-cloudflare/exact-retry` は、retry可能なtransport failure後に **同一scalar post-reserve transitionだけをexact replay** するためのoptional wrapperです。

baseの `RemoteCloudflareUsageStore` の挙動自体は変更しません。base clientは従来どおり、1 method callにつきnetwork attemptを1回だけ実行します。

このhelperはprovider-neutral coreではなくCloudflare packageに置きます。retry可否が `CloudflareUsageTransportError` とHTTP statusというprovider-specific transport semanticsに依存し、core `UsageStore` にtransport分類を持ち込まないためです。

## Safety boundary

retry対象は次だけです。

- `markLiable()`
- `renew()`
- `settle()`

次はretryしません。

- initial `reserve()`
- `reserveVector()`
- scalar / vector growth
- vector settlement

initial reserveのambiguous outcomeは、別のread-only operation reconciliation pathを使います。reserve reconciliationをretry middlewareで置き換えてはいけません。

retry対象transport classも意図的に限定します。

- local timeout
- network failure
- HTTP `408`
- HTTP `429`
- HTTP `5xx`

authentication failure、通常の `4xx`、protocol validation failure、Store conflict、その他application errorは即座にcallerへ返します。

## Usage

```ts
import { RemoteCloudflareUsageStore } from 'mcp-usage-control-cloudflare';
import {
  createExactRetryingRemoteCloudflareUsageStore,
} from 'mcp-usage-control-cloudflare/exact-retry';

const remote = new RemoteCloudflareUsageStore({
  endpoint: process.env.USAGE_STORE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.USAGE_STORE_TOKEN!}`,
  }),
});

const store = createExactRetryingRemoteCloudflareUsageStore(remote, {
  // initial attemptを含む総call数。default: 2、許容範囲: 1..4。
  maxAttempts: 2,
});
```

`maxAttempts: 2` はexact replay最大1回です。`maxAttempts: 1` にするとwrapper shapeを変えずretryを無効化できます。

対象methodでは、最初のattempt前にscalar inputをsnapshotし、retryでも同じsnapshotを使います。reservation ID、TTL、actual units、settlement outcomeをattempt間で変更しません。

`renew()` のTTLはStore clock基準のrelative値です。最初のrenewalがcommit済みでACKだけ失われた場合、exact replayで `expiresAt` がさらに先へ進むことがあります。quota capacityを長めに保持し得るconservativeな挙動であり、新しいreservation作成やreserved units増加は行いません。

## このhelperが証明しないこと

最終的にretryが成功しても、最初のtransport attemptがACK loss前にcommit済みだったかどうかまでは証明しません。証明できるのは、同じstate transitionがStore上で表現されていることだけです。

conflicting exact replayは引き続きerrorです。unknown / conflictをsuccessへ変換せず、raw reservation / operation / budget identifierもlogしません。

ambiguous initial reserveは [Cloudflare reserve reconciliation](cloudflare-reserve-reconciliation.ja.md) を参照してください。
