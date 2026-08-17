# MCPでのProgressive Reservation Growth

[English](progressive-mcp-integration.md) | [日本語](progressive-mcp-integration.ja.md)

Progressive growthは、「次のmetered stepの最大増分はboundedだが、operation全体の最終量を開始時に現実的に決めにくい」場合だけ使う。最大量を事前に決められるtoolは従来のfixed reservation adapterを使う。

重要な順序は次のとおり。

```text
small reserve
-> mark liable
-> 次のbounded step分のcapacityをauthoritativeに確保
-> metered step実行
-> 繰り返し
-> actual usageをsettle
```

growthがdenyまたはambiguousなら、**次のmetered stepを実行してよいという意味にはならない**。

## MCP向けTypeScript pattern

```ts
import { UsageControl, UsageDeniedError } from 'mcp-usage-control';

async function runProgressiveMcpTool({
  control,
  operationId,
  principal,
  args,
  runOneMeteredStep,
}) {
  const budgets = [
    { key: `requests:${principal.id}:current-window`, limit: 100 },
  ];

  const admission = await control.reserve({
    operationId,
    principal,
    tool: 'iterative-retrieval',
    args,
  });
  if (!admission.allowed) throw new UsageDeniedError(admission.reason);

  const { lease } = admission;
  await lease.markLiable();

  let actualUnits = 0;
  let incrementSequence = 0;

  try {
    while (needsAnotherStep()) {
      // この例ではprovider step 1回の最大消費量が1 unitと事前に分かっている。
      const nextStepMaximum = 1;

      if (actualUnits + nextStepMaximum > lease.reservedUnits) {
        // process lossから復帰する必要があるoperationでは、growth送信前に
        // このidentityを永続化するかdeterministicに再構成できるようにする。
        const incrementId = `${operationId}:growth:${incrementSequence}`;

        const growth = await lease.grow({
          incrementId,
          additionalUnits: 5,
          budgets,
        });

        if (!growth.accepted) {
          // 追加provider/metered stepを開始しない。
          break;
        }
        incrementSequence += 1;
      }

      // current capacityがauthoritativeに確保された後だけmetered workを開始する。
      await runOneMeteredStep();
      actualUnits += 1;
    }

    return await lease.settle(actualUnits, 'success');
  } catch (error) {
    // grow()のStore/transport errorはambiguousかもしれないためfail closed。
    // fresh incrementIdを作らず、追加metered workも開始しない。
    // same logical operationを安全にresumeできる場合だけ同じincrement identityをretryする。
    throw error;
  }
}
```

`incrementId`はcapacity increase 1回のidentityであり、MCP business resultやprovider side effectのreplay identityではない。

## Multi-round / Tasks

全round / task continuationで元の`operationId`、reservation、growth cursorを維持する。server-side flowをsuspendする場合は`lease.toResumeState()`と、再試行が必要になり得るapplication-ownedなstable growth identityを保存する。

capacity確保のためだけにsecond `operationId`を作らない。それは既存reservationのgrowthではなく独立reservationになる。

growth ACKを失った場合:

1. 追加metered stepを開始しない。
2. same reservation/cursorに対してsame `incrementId` + same parametersだけretryする。
3. commit済みならexact replayされ、二重reserveしない。
4. stale cursorでfresh incrementを送るとfail closed。
5. settlement/expiry後はreplayを含む全growth callをrejectする。

## Adapter境界

`protectTool()`は実用的なbounded maximumを事前に決められるworkload向けの推奨wrapperのまま。Progressive workloadではmetered step前にleaseへアクセスする必要があるため、v0.6では既存handler signatureを変えたりoptimistic実行を暗黙導入したりせず、explicit lifecycleを標準patternとして文書化する。
