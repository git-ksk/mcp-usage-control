# Vector MCP integration

1つのMCP tool executionが異なるmetering dimensionを1 logical operationとしてreserve / settleする必要がある場合にvector accountingを使います。

`protectTool()`はbounded scalar convenience wrapperのままです。v0.7ではhandler APIをscalar/vector unionへ広げません。vector workloadはexplicit lifecycleを使い、各metered stepの前にcapacityを確認します。

## Example

```ts
import { VectorUsageControl, type VectorUsagePolicy } from 'mcp-usage-control';

const policy: VectorUsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      dimensions: [
        {
          key: 'requests',
          units: 1,
          budgets: [{ key: `requests:${request.principal.id}:day`, limit: 100 }],
        },
        {
          key: 'tokens',
          units: 512,
          budgets: [{ key: `tokens:${request.principal.id}:day`, limit: 100_000 }],
        },
      ],
    };
  },
};

const usage = new VectorUsageControl(store, policy);
const admission = await usage.reserve({ operationId, principal, tool: 'stream-answer', args });
if (!admission.allowed) throw new Error(admission.reason);

const { lease } = admission;
await lease.markLiable();

let actualTokens = 0;
for (const chunk of plannedChunks) {
  const required = estimateNextChunkTokens(chunk);
  const reserved = lease.reservedByDimension.find(item => item.key === 'tokens')?.reservedUnits ?? 0;

  if (actualTokens + required > reserved) {
    const growth = await lease.grow({
      incrementId: stableIncrementId(operationId, chunk.sequence),
      dimensions: [
        {
          key: 'requests',
          additionalUnits: 0,
          budgets: [{ key: `requests:${principal.id}:day`, limit: 100 }],
        },
        {
          key: 'tokens',
          additionalUnits: required,
          budgets: [{ key: `tokens:${principal.id}:day`, limit: 100_000 }],
        },
      ],
    });
    if (!growth.accepted) break;
  }

  // authoritative capacityを確保してからmetered workを開始する。
  actualTokens += await generateChunk(chunk);
}

await lease.settle(
  [
    { key: 'requests', actualUnits: 1 },
    { key: 'tokens', actualUnits: actualTokens },
  ],
  'completed',
);
```

## Failure rule

1. business operationごとにstable `operationId`を1個作る。reconnect / retry / MCP Tasksで別vector reservationを作らない。
2. 最初のcost-causing side effect直前に`markLiable()`する。
3. 全required dimensionのauthoritative reserved capacityが確保されるまでmetered stepを開始しない。independent reserveはvector admissionの代替ではない。
4. process-loss recoveryが必要ならgrowth `incrementId`をsend前にpersistするかdeterministicに再構成できるようにする。
5. growth denial後は追加metered workを止める。完了済みworkはreserved bound内でsettleできる。
6. growth ACKがambiguousならguessしない。同じincrementをexact retryする。originalがcommit済みかもしれないためfresh IDはunsafe。
7. exact dimension vectorをsettleする。request数/token/秒/provider unitをsynthetic scalarへ変換しない。

## Multi-round / Tasks

multi-round toolやtaskは時点ごとに異なるdimensionをgrowできますが、logical operation全体では1 reservation・1 cursor・1 settlement vectorを維持します。durable resumeが必要なら`VectorUsageLeaseResumeState`をapplication task stateと一緒に保存します。

business result replayはapplication責務です。usage accountingはcapacity/lifecycleを証明しますが、toolの外部side effectをidempotentにはしません。
