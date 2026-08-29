# Cloudflare 実環境 E2E / dogfood 手順

[English](cloudflare-deployed-e2e.md) | [日本語](cloudflare-deployed-e2e.ja.md)

この手順では、local workerd に対して実行している Cloudflare integration suite と同じ検証を、実際の Cloudflare Worker + SQLite Durable Object に対して実行します。

必ず専用の破棄可能な Worker と synthetic identity を使用してください。production の usage-control domain にこの suite を向けないでください。

## 検証内容

- gateway authentication の fail-close
- 残り 1 unit に対する 100 並列 contention でちょうど 1 caller のみ admission
- atomic multi-budget denial
- duplicate operation protection
- settlement replay / conflicting replay
- pending expiry recovery
- liable expiry 時の conservative retention
- `markLiable`、複数回の `renew`、最終 `settle`
- lost reserve ACK を模擬し、blind retry しないこと
- lost settlement ACK を模擬し、同一 settlement replay で reconciliation できること
- observer failure isolation
- optional な dual-token credential rotation overlap と旧 credential retire 後の拒否
- local workerd のみ、実際の remote HTTP transport path を通した synthetic HTTP `429` / `503` の platform-style failure

テスト payload には sentinel の tool argument を意図的に含めています。transport / log review で raw tool arguments が Cloudflare usage-control boundary を越えていないことを確認できます。

local workerd の fault-injection route はテスト専用です。platform-style HTTP failure が fail-close のままで、business `quota_exceeded` に変換されないことを検証します。ただし、実際の Cloudflare Free-plan exhaustion や overload が発生したこと自体を証明するものではありません。

## 前提

- Workers と SQLite Durable Objects を deploy できる Cloudflare account
- 対象 account に対する Wrangler authentication
- Node.js 22+ と pnpm
- この repository の checkout

この手順のために Paid plan を有効化しないでください。dogfood config は Workers Free 互換で、専用 Worker 名 `mcp-usage-control-cloudflare-dogfood` を使用します。

## 1. Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

## 2. 一時 gateway secret を作成

値は repository 外に置きます。

```bash
umask 077
export MCP_USAGE_CLOUDFLARE_TOKEN="$(openssl rand -hex 32)"
printf 'MCP_USAGE_TEST_TOKEN=%s\n' "$MCP_USAGE_CLOUDFLARE_TOKEN" > /tmp/muc-dogfood.env
```

## 3. 専用 Worker を deploy

```bash
pnpm dlx wrangler@4.114.0 deploy \
  --config packages/cloudflare/wrangler.dogfood.jsonc \
  --secrets-file /tmp/muc-dogfood.env
```

Wrangler output の `workers.dev` URL を使って設定します。

```bash
export MCP_USAGE_CLOUDFLARE_URL='https://<worker>.<subdomain>.workers.dev/v1/usage-store'
```

Worker config は `MCP_USAGE_TEST_TOKEN` を required secret として宣言しています。optional な `MCP_USAGE_TEST_PREVIOUS_TOKEN` は credential rotation の overlap 中だけ使用します。どちらも Wrangler `vars` へ移したり commit したりしないでください。

## 4. deploy 後の health を待つ

Deploy 直後は propagation の間、endpoint が短時間利用できない場合があります。初期の短い `script not found` を accounting failure と判定しないでください。

```bash
HEALTH_URL="${MCP_USAGE_CLOUDFLARE_URL%/v1/usage-store}/health"
ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" -eq 1
```

## 5. 実環境 E2E を実行

```bash
node packages/cloudflare/test/integration.mjs
```

成功時は最後に次が表示されます。

```text
Cloudflare Durable Objects integration: PASS (<endpoint>)
```

この suite は有限な synthetic test です。1 run の大半は 100 並列 contention で、authentication probe を除き、おおむね 130 回の authenticated usage-store operation を実行します。SQLite row activity は budget 数と lazy cleanup work によって増えるため、1 protected MCP call = 1 Durable Object / SQLite operation と見なさないでください。

## 6. Privacy / operational signal を確認

Worker / Durable Object の log と metrics を確認し、次を検証します。

- synthetic request の raw principal/user ID が adapter path から出力されていない
- raw tenant ID、tool name、operation ID、budget key、tool arguments が adapter path から出力されていない
- authentication failure と business `quota_exceeded` を区別できる
- network/platform failure が成功 admission として扱われず error のまま fail-close する
- Cloudflare store 選択後に application が別 quota ledger へ fallback しない

unique ID を metric label にしないでください。

## 7. 無停止 Credential rotation 検証

Dogfood Worker は required な current token 1本と、optional な previous token 1本を受け付けます。認証断を作らないため、必ず次の順でrotationします。

### 7.1 現在tokenを previous slotへコピー

```bash
export MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN="$MCP_USAGE_CLOUDFLARE_TOKEN"
printf '%s' "$MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN" | \
  pnpm dlx wrangler@4.114.0 secret put MCP_USAGE_TEST_PREVIOUS_TOKEN \
    --config packages/cloudflare/wrangler.dogfood.jsonc
```

この時点では current / previous の両slotが意図的に同じ旧credentialを持ちます。

### 7.2 current slotを新tokenへ置換

```bash
export MCP_USAGE_CLOUDFLARE_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$MCP_USAGE_CLOUDFLARE_TOKEN" | \
  pnpm dlx wrangler@4.114.0 secret put MCP_USAGE_TEST_TOKEN \
    --config packages/cloudflare/wrangler.dogfood.jsonc
```

再度 `/health` を待ってから、新current credentialと旧previous credentialの両方が成功することを確認します。

```bash
node packages/cloudflare/test/rotation.mjs
```

成功時は `Cloudflare credential rotation: PASS` が表示されます。

### 7.3 application callerを新tokenへ切り替える

GCP-hosted MCP server等のcallerを新しい `MCP_USAGE_CLOUDFLARE_TOKEN` へ変更し、通常のusage-store smokeを1回通します。新tokenでのcaller動作を確認するまではprevious slotを削除しないでください。

### 7.4 旧tokenをretireする

旧tokenを拒否確認用にlocalへ残し、Worker側のprevious secretを削除します。

```bash
export MCP_USAGE_CLOUDFLARE_RETIRED_TOKEN="$MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN"
unset MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN
pnpm dlx wrangler@4.114.0 secret delete MCP_USAGE_TEST_PREVIOUS_TOKEN \
  --config packages/cloudflare/wrangler.dogfood.jsonc
```

もう一度 `/health` を待ってから実行します。

```bash
node packages/cloudflare/test/rotation.mjs
```

2回目は、新tokenが引き続き成功し、retire済み旧tokenが拒否されることを検証します。dual-token overlapは短く保ち、全caller切替後にprevious tokenを削除してください。

Public local-workerd CIでもcurrent token成功、previous token overlap成功、既知のretired token拒否を継続的に確認します。ただし、実際のsecret追加・置換・削除手順の確認にはdeployed Cloudflare runが必要です。

## 8. Platform limit / overload 検証

この手順では、テストのためだけに account の Workers Free quota を意図的に使い切りません。Free-tier exhaustion と実際の Cloudflare overload は外部 platform condition であり、共有 account で人為的に発生させるべきではありません。

local workerd CI では synthetic HTTP `429` / `503` を注入し、`RemoteCloudflareUsageStore` がどちらも business `quota_exceeded` とは別の fail-closed `CloudflareUsageTransportError('remote')` として扱うことを検証します。これにより Cloudflare quota を消費せず client-side failure contract を検証できます。

専用 dogfood environment で本物の platform-limit / overload が自然に発生した場合は Cloudflare error category を記録し、application が fail-close し、business quota denial と別に識別できることを確認してください。別 quota ledger への dynamic fallback は行いません。

Cloudflare の仕様上、Durable Objects Free-plan limit を超過すると、その種類の operation は該当 limit が reset されるまで失敗します。これは `mcp-usage-control` の `quota_exceeded` ではなく infrastructure/platform failure として扱います。

## 9. Teardown

まず一時 secret file と shell environment を削除します。

```bash
rm -f /tmp/muc-dogfood.env
unset MCP_USAGE_CLOUDFLARE_TOKEN MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN \
  MCP_USAGE_CLOUDFLARE_RETIRED_TOKEN MCP_USAGE_CLOUDFLARE_OLD_TOKEN \
  MCP_USAGE_CLOUDFLARE_URL
```

次に専用 Worker と関連 developer-platform resource を削除します。

```bash
pnpm dlx wrangler@4.114.0 delete \
  --config packages/cloudflare/wrangler.dogfood.jsonc
```

破壊確認は専用 dogfood Worker に対してのみ承認してください。Worker 自体を残して Durable Object class だけを retire する場合は、Cloudflare の declarative Durable Object class deletion / tombstone 手順を使います。class deletion は namespace の保存データを完全に破棄します。

## CI policy

Public CI は Cloudflare credential を使わず、local workerd に対して integration suite を実行します。通常の Durable Object accounting path に加えて、dual-token rotation overlap、retired credential拒否、synthetic `429` / `503` の fail-close 処理も継続的に確認します。実 Cloudflare run は manual / opt-in とし、secret-bearing live test を public CI の必須 check にしません。
