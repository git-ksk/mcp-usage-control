# Redis MCP multi-round flow store

[English](redis-mcp-flow-store.md) | [日本語](redis-mcp-flow-store.ja.md)

`mcp-usage-control-redis/mcp-flow` は、`protectMultiRoundTool()` が利用するserver-side flow-store contractのshared Redis implementationです。

MCP `input_required` のretry requestが別process / instanceへ到達し得て、`MemoryMcpUsageFlowStore` では不足する場合に利用します。

## Setup

```ts
import { createClient } from 'redis';
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';
import { protectMultiRoundTool } from 'mcp-usage-control-mcp';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const flowStore = new RedisMcpUsageFlowStore(redis);

const protectedTool = protectMultiRoundTool({
  control,
  tool: 'confirm-write',
  noInput: true,
  principal: ctx => trustedPrincipal(ctx),
  operationId: () => stableLogicalOperationId(),
  flowStore,
  requestState: { mint: payload => stateCodec.mint(payload) },
  suspendTtlMs: 5 * 60_000,
}, handler);
```

Redis subpathはMCP packageの `McpUsageFlowStore` contractとstructurally compatibleです。Redis packageからMCP packageへのruntime dependencyは追加しません。

## Atomic compare-and-consume

suspended flowは2つのRedis keyを使います。

```text
<prefix>:{mcp-flow:<flowId>}:record
<prefix>:{mcp-flow:<flowId>}:binding
```

1 flowの2 keyは同じRedis Cluster hash tagを共有するため、Luaでatomicに操作できます。別flow IDは別hash tagになり、cluster slotへ分散できます。

`consume(flowId, binding)` は1回のLua operationで次を行います。

1. flow payloadとstored binding digestを読む。
2. 片方のkeyだけ存在する場合はfail-closeする。
3. binding mismatchなら**正規flowを削除せず**no flowを返す。
4. binding matchなら同一atomic script内で2 keyをdeleteしpayloadを返す。

これによりresume tokenはprocessを跨いでone-timeになります。parallel contentionでもflow recordを受け取れるcallerは最大1つです。

## Binding

trusted bindingの対象:

```text
principalId
tenantId
tool
canonical argsHash
```

Redis binding keyにはこのtupleのSHA-256 digestを保存します。payload decode後にもcurrent bindingとの一致を再検証します。

flow IDはopaque lookup identifierでありauthorization proofではありません。clientを往復したMCP `requestState` は、このstoreへflow IDを渡す前にMCP server側でintegrity verificationされている必要があります。

## Expiry

`suspend()` にはresumable usage leaseと同じabsolute `expiresAt` を渡します。

Lua scriptはRedis server `TIME` を読み、すでにpastのexpiryをrejectし、2 keyをRedis `PXAT` で保存します。通常のsuspended-flow expiryにapplication cleanup timerは不要です。

Redis flow recordとusage reservationは別stateです。Redis expiryが消すのはresume capabilityだけです。underlying cost-liable usage leaseは自身の `UsageStore` expiry semanticsに従い、abandonされた場合はreserved chargeを保守的に維持します。

## Lost ACK / process-loss semantics

storeはLua callをautomatic retryしません。

### `suspend()` ACK loss

callerがerrorを見る前にRedis writeがcommit済みの可能性があります。callerはsuspensionをambiguousとして扱う必要があります。`protectMultiRoundTool()` はfail-closeし、second flowを勝手に作りません。

### `consume()` ACK loss

Lua scriptがone-time tokenをすでにatomic deleteしている可能性があります。そのため `consume()` retryは、初回claim成功済みでもmissingを返し得ます。安全な挙動はapplication handlerをblind再実行せずfail-closeすることです。

### Successful claim後のfailure

flow claim後にもbusiness resultがcallerへ届く前にprocess / transportがfailする可能性があります。usage resume tokenの再利用は意図的にrecovery mechanismにしません。

destructive / externally metered workではapplication / business idempotencyとresult reconciliationを維持してください。将来result cache / reconciliation layerを利用する場合もusage accounting stateとは分離し、retentionをboundします。

## Payload privacy / codec

**binding keyはhash化**しますが、default flow-record payload codecはJSONです。

main Redis `UsageStore` ledgerと違い、resumable flow recordは一時的なtrusted server-side workflow stateです。`UsageLeaseResumeState` を含むため、raw application accounting identity、tool名、budget key、plan、explicit observer metadataを含み得ます。

したがって:

- Redis deploymentをtrusted server-side infrastructureとして扱う。
- credential、tool argument、その他secretをaccounting identifier / metadataへ入れない。
- flow payloadをcompactに保つ。encoded payloadが64 KiBを超える場合adapterはrejectする。
- Redis/platform control以上のat-rest confidentialityが必要なら、custom `RedisMcpUsageFlowCodec` でrecordをstorage前にencrypt / authenticateする。

codec例:

```ts
const flowStore = new RedisMcpUsageFlowStore(redis, {
  codec: {
    async encode(record) {
      return encryptAndAuthenticate(JSON.stringify(record));
    },
    async decode(payload) {
      return JSON.parse(await decryptAndVerify(payload));
    },
  },
});
```

Luaのbinding comparisonはencoded record formatに依存しません。

## Failure policy

Redis / network / script failureはそのまま表面化します。successful resumeへ変換せず、process memoryや別flow ledgerへfallbackしません。

これはcore usage-control policyと同じで、storage ambiguityではone-time accounting / execution guaranteeを弱めるよりavailabilityを落とします。

## このadapterが提供しないもの

以下は提供しません。

- generic workflow engine。
- completed business-result cache / replay。
- arbitrary external side effectのexactly-once保証。
- MCP request-state signature / verification codecの代替。
- second usage ledger / fallback quota source。

責務は、server-side suspended-flow claimをMCP server instance間でdurable/sharedかつatomicにすることに限定します。
