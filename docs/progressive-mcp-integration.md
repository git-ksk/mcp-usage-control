# Progressive reservation growth with MCP

[English](progressive-mcp-integration.md) | [日本語](progressive-mcp-integration.ja.md)

Use progressive growth only when the next metered step has a bounded increment but the operation's final total is not practical to know at admission time. Bounded-cost tools should keep using the simpler fixed-reservation adapters.

The critical ordering is:

```text
small reserve
-> mark liable
-> prove capacity for the next bounded step
-> perform that metered step
-> repeat
-> settle actual usage
```

A denied or ambiguous growth attempt is **not** permission to perform another metered step.

## MCP-oriented TypeScript pattern

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
      // This example knows that one provider step can consume at most one unit.
      const nextStepMaximum = 1;

      if (actualUnits + nextStepMaximum > lease.reservedUnits) {
        // Persist or deterministically reconstruct this identity BEFORE sending
        // the growth request when the operation must survive process loss.
        const incrementId = `${operationId}:growth:${incrementSequence}`;

        const growth = await lease.grow({
          incrementId,
          additionalUnits: 5,
          budgets,
        });

        if (!growth.accepted) {
          // Do not start another provider/metered step.
          break;
        }
        incrementSequence += 1;
      }

      // Metered work begins only after current capacity is authoritative.
      await runOneMeteredStep();
      actualUnits += 1;
    }

    return await lease.settle(actualUnits, 'success');
  } catch (error) {
    // A Store/transport error from grow() is ambiguous and fail-closed.
    // Do not generate a new incrementId and do not start more metered work.
    // Retry the same increment identity only if the application can safely
    // resume the same logical operation; otherwise stop conservatively.
    throw error;
  }
}
```

The example deliberately keeps the growth attempt outside business-result replay. `incrementId` identifies one capacity increase, not one MCP result or provider side effect.

## Multi-round and Tasks

Keep the original `operationId`, reservation, and growth cursor across every round/task continuation. A suspended server-side flow should persist `lease.toResumeState()` together with the application-owned stable identity of any growth attempt that may need replay.

Do **not** create a second `operationId` merely to obtain more capacity. That would create an independent reservation rather than grow the existing logical operation.

If a growth acknowledgement is lost:

1. no further metered step starts;
2. retry only the same `incrementId` and parameters against the same reservation/cursor;
3. an exact committed retry replays the recorded result without reserving twice;
4. a fresh increment on the stale cursor fails closed;
5. after settlement or expiry, every growth call is rejected, including replay.

## Adapter boundary

`protectTool()` remains the recommended convenience wrapper for workloads with a practical bounded maximum. Progressive workloads need the lease before each metered step, so v0.6 documents the explicit lifecycle rather than changing the existing handler signature or silently making the adapter optimistic.
