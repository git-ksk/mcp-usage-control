# Use from source

[English](using-from-source.md) | [日本語](using-from-source.ja.md)

> **Current distribution status:** all five packages are published to npm at `1.1.0`. This page remains the source/local-tarball path for contributors, unreleased commits, local patches, and pre-release dogfooding.

## GitHub Release artifacts

Starting with release-workflow hardening after v0.11.0, source releases attach the five **exact CI-validated package tarballs** plus `SHA256SUMS`, with GitHub artifact attestations generated for the same tarballs. Verify the checksum before installing an attached archive; do not assume a similarly named local rebuild is byte-identical.

For normal application installs, use npm. The archives are useful when you need to inspect or install an exact release artifact; a local rebuild is not automatically byte-identical to that artifact.

## 1. Clone and verify the repository

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm build
pnpm example:free-plus
```

These commands verify the build and service-free example. For validation with Redis, see [Contributing](../CONTRIBUTING.md). Some Redis integration tests are skipped when `REDIS_URL` is unset.

Requirements:

- Node.js 22+
- pnpm 10.15.0 for repository development
- Redis 7 for Redis adapter tests/usage
- Wrangler/workerd only when running the dedicated Cloudflare integration path

## 2. Pack the five packages locally

From the repository root:

```console
mkdir -p .packs
pnpm build
pnpm --dir packages/core pack --pack-destination "$PWD/.packs"
pnpm --dir packages/mcp pack --pack-destination "$PWD/.packs"
pnpm --dir packages/redis pack --pack-destination "$PWD/.packs"
pnpm --dir packages/cloudflare pack --pack-destination "$PWD/.packs"
pnpm --dir packages/firestore pack --pack-destination "$PWD/.packs"
version="$(node -p "require('./packages/core/package.json').version")"
printf 'packed version: %s\n' "$version"
```

This produces the five package tarballs for the current checkout version, for example:

```text
.packs/mcp-usage-control-${version}.tgz
.packs/mcp-usage-control-mcp-${version}.tgz
.packs/mcp-usage-control-redis-${version}.tgz
.packs/mcp-usage-control-cloudflare-${version}.tgz
.packs/mcp-usage-control-firestore-${version}.tgz
```

These tarballs contain the current local build, including any local changes. The release CI also checks package contents and public ESM imports in a clean consumer project; local packing alone does not reproduce all of that validation.

## 3. Install into another project

Use absolute or correctly resolved paths from the consumer project. Resolve the checkout version first and install the local tarballs together so adapter packages resolve the local core package from the same checkout rather than mixing registry and local artifacts.

```console
version="$(node -p "require('/absolute/path/to/mcp-usage-control/packages/core/package.json').version")"
```

Core only:

```console
npm install "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-${version}.tgz"
```

Core + MCP adapter:

```console
npm install \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-mcp-${version}.tgz" \
  @modelcontextprotocol/server@2.0.0
```

Core + Redis adapter:

```console
npm install \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-redis-${version}.tgz" \
  redis@6.2.0
```

Core + Cloudflare adapter:

```console
npm install \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-cloudflare-${version}.tgz"
```

Core + Firestore adapter (choose a server Firestore client for actual use):

```console
npm install \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-firestore-${version}.tgz" \
  firebase-admin
```

`@google-cloud/firestore` can be used instead of `firebase-admin`. The adapter intentionally does not bundle either client as a runtime dependency.

All five:

```console
npm install \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-mcp-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-redis-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-cloudflare-${version}.tgz" \
  "/absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-firestore-${version}.tgz" \
  @modelcontextprotocol/server@2.0.0 \
  redis@6.2.0
```

## 4. Verify imports in the consumer project

```console
node --input-type=module <<'NODE'
import { MemoryUsageStore, UsageControl } from 'mcp-usage-control';
import {
  UsageOperationalMonitor,
  createUsageRuntimeIdentity,
  projectScopedQuota,
} from 'mcp-usage-control/operational';
import {
  InvalidSettlementOutcomeError,
  normalizeSettlementOutcome,
} from 'mcp-usage-control/settlement-outcomes';
import {
  didUsageQuotaThresholdCross,
  evaluateUsageQuotaThreshold,
} from 'mcp-usage-control/thresholds';
import { protectTool } from 'mcp-usage-control-mcp';
import { RedisUsageStore } from 'mcp-usage-control-redis';
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';
import { CloudflareUsageStore, RemoteCloudflareUsageStore } from 'mcp-usage-control-cloudflare';
import { FirestoreUsageStore } from 'mcp-usage-control-firestore';

if (![
  MemoryUsageStore,
  UsageControl,
  UsageOperationalMonitor,
  createUsageRuntimeIdentity,
  projectScopedQuota,
  InvalidSettlementOutcomeError,
  normalizeSettlementOutcome,
  didUsageQuotaThresholdCross,
  evaluateUsageQuotaThreshold,
  protectTool,
  RedisUsageStore,
  RedisMcpUsageFlowStore,
  CloudflareUsageStore,
  RemoteCloudflareUsageStore,
  FirestoreUsageStore,
].every(Boolean)) {
  throw new Error('mcp-usage-control local package import failed');
}

console.log('mcp-usage-control local packages are ready');
NODE
```

Do not import `mcp-usage-control-cloudflare/worker` from a plain Node process; that subpath targets the Cloudflare Workers runtime. The main Cloudflare package entry point remains importable from Node for remote clients.

If you only installed a subset of packages, import only that subset.

## 5. Develop directly against the checkout

For changes to the runtime itself, work inside the repository and run:

```console
pnpm check
```

The in-memory store is suitable for tests and local development. Use the Redis adapter, the dedicated Cloudflare workerd integration workflow, or the Firestore Emulator integration workflow for distributed-enforcement verification.
