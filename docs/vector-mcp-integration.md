# Vector MCP integration

Use vector accounting when one MCP tool execution must reserve and settle unlike metering dimensions as one logical operation.

`protectTool()` remains the bounded scalar convenience wrapper. v0.7 does not widen that handler API into scalar/vector unions. Vector workloads use the explicit lifecycle so the application can reason about each metered step before execution.

## Example

```ts
import {
  VectorUsageControl,
  type VectorUsagePolicy,
} from 'mcp-usage-control';
import { RedisUsageStore } from 'mcp-usage-control-redis';

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

const usage = new VectorUsageControl(redisStore, policy);
const admission = await usage.reserve({
  operationId,
  principal,
  tool: 'stream-answer',
  args,
});

if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

const { lease } = admission;
await lease.markLiable();

let actualTokens = 0;
for (const chunk of plannedChunks) {
  const required = estimateNextChunkTokens(chunk);
  const currentlyReserved =
    lease.reservedByDimension.find(item => item.key === 'tokens')?.reservedUnits ?? 0;

  if (actualTokens + required > currentlyReserved) {
    const incrementId = stableIncrementId(operationId, chunk.sequence);
    const growth = await lease.grow({
      incrementId,
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

  // Metered work starts only after authoritative capacity exists.
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

## Failure rules

1. **Create one stable `operationId` for the business operation.** Reconnects, retries, and MCP Tasks must not create a second vector reservation for the same logical execution.
2. **Mark liability immediately before the first cost-causing side effect.** Do not mark liable just because the request was parsed.
3. **Do not start a metered step until every required dimension has authoritative reserved capacity.** Independent reserves are not a substitute for vector admission.
4. **Persist or deterministically reconstruct each growth `incrementId` before sending it** if process-loss recovery is required.
5. **On growth denial, stop additional metered work.** Already completed work may still be settled within its reserved bounds.
6. **On ambiguous growth acknowledgement, do not guess.** Retry the exact same increment. A fresh ID is unsafe because the original may already have committed.
7. **Settle the exact dimension vector.** Do not convert request count, tokens, seconds, or provider units into one synthetic scalar.

## Multi-round and Tasks

A multi-round tool or task may grow different dimensions at different times, but it still owns one reservation, one cursor, and one settlement vector for the logical operation. Store the `VectorUsageLeaseResumeState` alongside the application's task state when durable resume is needed.

Business result replay remains application-owned. Usage accounting proves capacity/lifecycle state; it does not make the tool's external side effects idempotent.
