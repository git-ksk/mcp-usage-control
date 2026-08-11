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
- optional な credential rotation 後の旧 credential 拒否
- local workerd のみ、実際の remote HTTP transport path を通した synthetic HTTP `429` / `503` の platform-style failure

テスト payload には sentinel の tool argument を意図的に含めています。transport / log review で raw tool arguments が Cloudflare usage-control boundary を越えていないことを確認できます。

local workerd の fault-injection route はテスト専用です。platform-style HTTP failure が fail-close のままで、business `quota_exceeded` に変換されないことを検証します。ただし、実際の Cloudflare Free-plan exhaustion や overload が発生したこと自体を証明するものではありません。

## 前提

- Workers と SQLite Durable Objects を deploy できる Cloudflare account
- 対象 account に対する Wrangler authentication
- Node.js 20+ と pnpm
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

Worker config は `MCP_USAGE_TEST_TOKEN` を required secret として宣言しています。値を Wrangler `vars` へ移したり commit したりしないでください。

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

## 7. Credential rotation 検証

現在 token を保存し、新 token へ rotation したうえで、両方を環境変数に設定して suite を再実行します。

```bash
export MCP_USAGE_CLOUDFLARE_OLD_TOKEN="$MCP_USAGE_CLOUDFLARE_TOKEN"
export MCP_USAGE_CLOUDFLARE_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$MCP_USAGE_CLOUDFLARE_TOKEN" | \
  pnpm dlx wrangler@4.114.0 secret put MCP_USAGE_TEST_TOKEN \
    --config packages/cloudflare/wrangler.dogfood.jsonc
```

再度 `/health` を待ってから実行します。

```bash
node packages/cloudflare/test/integration.mjs
```

`MCP_USAGE_CLOUDFLARE_OLD_TOKEN` が設定されている場合、suite は旧 credential が拒否され、新 credential が成功することも検証します。Public の local-workerd CI でも既知の stale token を設定し、この拒否動作自体は継続的に検証します。ただし、実際の secret rotation 手順の確認には deployed Cloudflare run が必要です。

## 8. Platform limit / overload 検証

この手順では、テストのためだけに account の Workers Free quota を意図的に使い切りません。Free-tier exhaustion と実際の Cloudflare overload は外部 platform condition であり、共有 account で人為的に発生させるべきではありません。

local workerd CI では synthetic HTTP `429` / `503` を注入し、`RemoteCloudflareUsageStore` がどちらも business `quota_exceeded` とは別の fail-closed `CloudflareUsageTransportError('remote')` として扱うことを検証します。これにより Cloudflare quota を消費せず client-side failure contract を検証できます。

専用 dogfood environment で本物の platform-limit / overload が自然に発生した場合は Cloudflare error category を記録し、application が fail-close し、business quota denial と別に識別できることを確認してください。別 quota ledger への dynamic fallback は行いません。

Cloudflare の仕様上、Durable Objects Free-plan limit を超過すると、その種類の operation は該当 limit が reset されるまで失敗します。これは `mcp-usage-control` の `quota_exceeded` ではなく infrastructure/platform failure として扱います。

## 9. Teardown

まず一時 secret file と shell environment を削除します。

```bash
rm -f /tmp/muc-dogfood.env
unset MCP_USAGE_CLOUDFLARE_TOKEN MCP_USAGE_CLOUDFLARE_OLD_TOKEN MCP_USAGE_CLOUDFLARE_URL
```

次に専用 Worker と関連 developer-platform resource を削除します。

```bash
pnpm dlx wrangler@4.114.0 delete \
  --config packages/cloudflare/wrangler.dogfood.jsonc
```

破壊確認は専用 dogfood Worker に対してのみ承認してください。Worker 自体を残して Durable Object class だけを retire する場合は、Cloudflare の declarative Durable Object class deletion / tombstone 手順を使います。class deletion は namespace の保存データを完全に破棄します。

## CI policy

Public CI は Cloudflare credential を使わず、local workerd に対して integration suite を実行します。通常の Durable Object accounting path に加えて、stale credential 拒否と synthetic `429` / `503` の fail-close 処理も継続的に確認します。実 Cloudflare run は manual / opt-in とし、secret-bearing live test を public CI の必須 check にしません。
