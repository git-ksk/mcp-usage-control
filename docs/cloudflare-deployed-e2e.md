# Cloudflare deployed E2E / dogfood runbook

[English](cloudflare-deployed-e2e.md) | [日本語](cloudflare-deployed-e2e.ja.md)

This runbook exercises the same Cloudflare integration suite used against local workerd against a real Cloudflare Worker + SQLite Durable Object deployment.

Use only a dedicated disposable Worker and synthetic identities. Do not point this suite at a production usage-control domain.

## What it validates

The suite covers:

- gateway authentication fails closed;
- 100-way quota contention admits exactly one caller for one remaining unit;
- atomic multi-budget denial;
- duplicate operation protection;
- settlement replay and conflicting replay;
- pending expiry recovery;
- liable expiry with conservative retention;
- `markLiable`, repeated `renew`, and final `settle`;
- simulated lost reserve acknowledgement without blind retry;
- simulated lost settlement acknowledgement with identical settlement reconciliation;
- observer failure isolation;
- optional dual-token credential-rotation overlap and post-retirement rejection;
- on local workerd only, synthetic HTTP `429` and `503` platform-style failures through the real remote HTTP transport path.

The test payload intentionally contains a sentinel tool argument so transport/log review can verify that raw tool arguments do not cross the Cloudflare usage-control boundary.

The local workerd fault-injection routes are test-only. They prove that platform-style HTTP failures stay fail-closed and are not converted into a business `quota_exceeded` result. They do **not** prove that a genuine Cloudflare Free-plan exhaustion or overload condition has occurred.

## Prerequisites

- a Cloudflare account that can deploy Workers and SQLite Durable Objects;
- Wrangler authentication for the target account;
- Node.js 20+ and pnpm;
- a checkout of this repository.

Do not enable a Paid plan for this procedure. The dogfood configuration is compatible with Workers Free and uses a dedicated Worker name: `mcp-usage-control-cloudflare-dogfood`.

## 1. Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

## 2. Create a temporary gateway secret

Keep the value outside the repository. For example:

```bash
umask 077
export MCP_USAGE_CLOUDFLARE_TOKEN="$(openssl rand -hex 32)"
printf 'MCP_USAGE_TEST_TOKEN=%s\n' "$MCP_USAGE_CLOUDFLARE_TOKEN" > /tmp/muc-dogfood.env
```

## 3. Deploy the dedicated Worker

```bash
pnpm dlx wrangler@4.114.0 deploy \
  --config packages/cloudflare/wrangler.dogfood.jsonc \
  --secrets-file /tmp/muc-dogfood.env
```

Copy the deployed `workers.dev` URL from Wrangler output and set:

```bash
export MCP_USAGE_CLOUDFLARE_URL='https://<worker>.<subdomain>.workers.dev/v1/usage-store'
```

The Worker config declares `MCP_USAGE_TEST_TOKEN` as a required secret. The optional `MCP_USAGE_TEST_PREVIOUS_TOKEN` secret is used only during a credential-rotation overlap window. Do not move either value into Wrangler `vars` or commit it.

## 4. Wait for deployed health

Immediately after a deployment, the endpoint can briefly be unavailable while the deployment propagates. Do not classify a short initial `script not found` period as an accounting failure.

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

## 5. Run the real deployed E2E

```bash
node packages/cloudflare/test/integration.mjs
```

A successful run ends with:

```text
Cloudflare Durable Objects integration: PASS (<endpoint>)
```

The suite is intentionally finite and synthetic. One run is dominated by the 100-way contention case and performs roughly 130 authenticated usage-store operations, plus authentication probes. SQLite row activity is higher and depends on the number of budgets touched and lazy cleanup work; do not equate one protected MCP call with one Durable Object or SQLite operation.

## 6. Review privacy and operational signals

For the deployed test, inspect Worker/Durable Object logs and metrics and confirm:

- no raw principal/user ID from the synthetic request is emitted by the adapter path;
- no raw tenant ID, tool name, operation ID, budget key, or tool arguments are emitted by the adapter path;
- authentication failures are distinguishable from business `quota_exceeded` decisions;
- network/platform failures remain errors rather than being treated as successful admissions;
- there is no application-side fallback to a second quota ledger after the Cloudflare store has been selected.

Avoid adding unique IDs as metric labels.

## 7. Zero-downtime credential rotation validation

The dogfood Worker accepts one required current token and one optional previous token. Rotate in this order so at least one credential remains valid throughout the change.

### 7.1 Copy the current token into the previous-token slot

```bash
export MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN="$MCP_USAGE_CLOUDFLARE_TOKEN"
printf '%s' "$MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN" | \
  pnpm dlx wrangler@4.114.0 secret put MCP_USAGE_TEST_PREVIOUS_TOKEN \
    --config packages/cloudflare/wrangler.dogfood.jsonc
```

At this point both slots intentionally contain the old credential.

### 7.2 Replace the current-token slot with a new token

```bash
export MCP_USAGE_CLOUDFLARE_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$MCP_USAGE_CLOUDFLARE_TOKEN" | \
  pnpm dlx wrangler@4.114.0 secret put MCP_USAGE_TEST_TOKEN \
    --config packages/cloudflare/wrangler.dogfood.jsonc
```

Wait for `/health` again, then verify that both the new current credential and the old previous credential work:

```bash
node packages/cloudflare/test/rotation.mjs
```

A successful overlap check ends with a `Cloudflare credential rotation: PASS` message.

### 7.3 Move the application caller to the new token

Update the GCP-hosted MCP server or other caller to use the new `MCP_USAGE_CLOUDFLARE_TOKEN`, then perform a normal usage-store smoke call. Do not remove the previous-token slot until the new caller configuration is confirmed.

### 7.4 Retire the old token

Preserve the old value locally for the rejection assertion, then remove the Worker-side previous secret:

```bash
export MCP_USAGE_CLOUDFLARE_RETIRED_TOKEN="$MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN"
unset MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN
pnpm dlx wrangler@4.114.0 secret delete MCP_USAGE_TEST_PREVIOUS_TOKEN \
  --config packages/cloudflare/wrangler.dogfood.jsonc
```

Wait for `/health` once more and rerun:

```bash
node packages/cloudflare/test/rotation.mjs
```

The second run verifies that the new token still succeeds and the retired token is now rejected. Keep the dual-token overlap short and delete the previous token after all callers have moved.

Public local-workerd CI continuously checks current-token acceptance, previous-token overlap acceptance, and a known retired-token rejection. The real secret update/delete sequence still requires a deployed Cloudflare run.

## 8. Platform-limit / overload validation

This runbook does **not** intentionally burn through an account's Workers Free quota. Free-tier exhaustion and genuine Cloudflare overload are external platform conditions and should not be manufactured in shared accounts merely to satisfy a test.

Local workerd CI injects synthetic HTTP `429` and `503` responses and verifies that `RemoteCloudflareUsageStore` maps both to a fail-closed `CloudflareUsageTransportError('remote')`, distinct from business `quota_exceeded`. This covers the client-side failure contract without consuming Cloudflare quota.

When a genuine platform-limit or overload condition is naturally observed in a dedicated dogfood environment, capture the Cloudflare error category and verify the application fails closed and reports it separately from a business quota denial. Do not dynamically fall back to another quota ledger.

Cloudflare documents that exceeding a Durable Objects Free-plan limit causes further operations of that type to fail until the relevant limit resets. Treat that as an infrastructure/platform failure, not as `quota_exceeded` from `mcp-usage-control`.

## 9. Teardown

Remove the temporary secret file first:

```bash
rm -f /tmp/muc-dogfood.env
unset MCP_USAGE_CLOUDFLARE_TOKEN MCP_USAGE_CLOUDFLARE_PREVIOUS_TOKEN \
  MCP_USAGE_CLOUDFLARE_RETIRED_TOKEN MCP_USAGE_CLOUDFLARE_OLD_TOKEN \
  MCP_USAGE_CLOUDFLARE_URL
```

Then delete the dedicated Worker and its associated developer-platform resources:

```bash
pnpm dlx wrangler@4.114.0 delete \
  --config packages/cloudflare/wrangler.dogfood.jsonc
```

Confirm the destructive prompt only for the dedicated dogfood Worker. If a Durable Object class is being retired while the Worker itself is retained, use Cloudflare's declarative Durable Object class deletion/tombstone procedure instead; class deletion permanently destroys that namespace's stored data.

## CI policy

Public CI runs the integration suite against local workerd without Cloudflare credentials. It continuously checks the normal Durable Object accounting path, dual-token rotation overlap, retired-credential rejection, and synthetic `429`/`503` fail-closed handling. A real deployed run is manual/opt-in and must not become a required secret-bearing public CI check.
