# Sourceから使う

[English](using-from-source.md) | [日本語](using-from-source.ja.md)

> **現在の配布状況:** packageはまだnpmへ公開していません。初回registry publishが完了するまでは、repository checkoutまたはローカルでpackしたtarballを使ってください。

## 1. Repositoryをcloneして検証

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

必要条件:

- Node.js 20+
- repository開発ではpnpm 10.15.x
- Redis adapterのtest / 利用ではRedis 7
- Cloudflare専用integration pathを実行する場合のみWrangler / workerd

## 2. 5 packageをローカルpack

repository rootで実行します。

```console
rm -rf .packs
mkdir -p .packs
pnpm --dir packages/core pack --pack-destination "$PWD/.packs"
pnpm --dir packages/mcp pack --pack-destination "$PWD/.packs"
pnpm --dir packages/redis pack --pack-destination "$PWD/.packs"
pnpm --dir packages/cloudflare pack --pack-destination "$PWD/.packs"
pnpm --dir packages/firestore pack --pack-destination "$PWD/.packs"
```

次のtarballが生成されます。

```text
.packs/mcp-usage-control-0.2.0.tgz
.packs/mcp-usage-control-mcp-0.2.0.tgz
.packs/mcp-usage-control-redis-0.2.0.tgz
.packs/mcp-usage-control-cloudflare-0.2.0.tgz
.packs/mcp-usage-control-firestore-0.2.0.tgz
```

現時点では、このtarballが将来のnpm packageに最も近い利用形態です。CIでも同じtarballを生成し、source / test fileの混入がないことを確認し、cleanなconsumer projectへinstallしてpublic ESM importまで検証します。

## 3. 別projectへinstall

consumer projectからabsolute pathまたは正しく解決できるpathを指定します。adapter packageが未公開npmのcore packageを取りに行かないよう、必要なlocal tarballは同じinstall commandで指定するのが安全です。

Coreのみ:

```console
npm install /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-0.2.0.tgz
```

Core + MCP adapter:

```console
npm install \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-mcp-0.2.0.tgz \
  @modelcontextprotocol/server@2.0.0
```

Core + Redis adapter:

```console
npm install \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-redis-0.2.0.tgz \
  redis@6.2.0
```

Core + Cloudflare adapter:

```console
npm install \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-cloudflare-0.2.0.tgz
```

Core + Firestore adapter（実利用ではserver-side Firestore clientを1つ選択）:

```console
npm install \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-firestore-0.2.0.tgz \
  firebase-admin
```

`firebase-admin` の代わりに `@google-cloud/firestore` も利用できます。adapterはどちらもruntime dependencyとしてbundleしません。

5 packageすべて:

```console
npm install \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-mcp-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-redis-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-cloudflare-0.2.0.tgz \
  /absolute/path/to/mcp-usage-control/.packs/mcp-usage-control-firestore-0.2.0.tgz \
  @modelcontextprotocol/server@2.0.0 \
  redis@6.2.0
```

## 4. Consumer projectでimport確認

```console
node --input-type=module <<'NODE'
import { MemoryUsageStore, UsageControl } from 'mcp-usage-control';
import { protectTool } from 'mcp-usage-control-mcp';
import { RedisUsageStore } from 'mcp-usage-control-redis';
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';
import { CloudflareUsageStore, RemoteCloudflareUsageStore } from 'mcp-usage-control-cloudflare';
import { FirestoreUsageStore } from 'mcp-usage-control-firestore';

if (![MemoryUsageStore, UsageControl, protectTool, RedisUsageStore, RedisMcpUsageFlowStore, CloudflareUsageStore, RemoteCloudflareUsageStore, FirestoreUsageStore].every(Boolean)) {
  throw new Error('mcp-usage-control local package import failed');
}

console.log('mcp-usage-control local packages are ready');
NODE
```

plain Node processから `mcp-usage-control-cloudflare/worker` をimportしないでください。このsubpathはCloudflare Workers runtime向けです。Cloudflare packageのmain entry pointはremote client用途としてNodeからimportできます。

一部packageだけinstallした場合は、そのpackageだけimportしてください。

## 5. Checkoutを直接開発する場合

runtime自体を変更するときはrepository内で作業し、次を実行します。

```console
pnpm check
```

in-memory storeはtest / local development向けです。distributed enforcementの確認ではRedis adapter、Cloudflare専用workerd integration workflow、またはFirestore Emulator integration workflowを使います。

## npm公開後

初回npm publish完了後は、public docsのprimary install手順をregistry installへ切り替えます。このsource / tarball手順は、その後もcontributor、未release commit、local patch、pre-release dogfooding向けとして残します。
