# Free / Plus monthly credits

A runnable, self-verifying first example for `mcp-usage-control`.

It models:

```text
Free   -> 50 credits / month
Plus   -> 500 credits / month
search -> 1 credit
report -> 10 credits
```

The script spends 40 Free credits, races two 10-credit reports for the final 10 credits, and asserts that exactly one is admitted. It then repeats the admitted logical operation ID and asserts that duplicate admission cannot create a new charge.

From the repository root:

```console
pnpm example:free-plus
```

Expected result:

```text
PASS: Free plan stopped concurrent overspend at 50/50 credits.
PASS: duplicate logical operation was rejected instead of charging another 10 credits.
The same policy can quote Plus users at 500 credits/month.
```

This example uses `MemoryUsageStore` so it runs with no external service. Production deployments that need restart durability or multiple instances should choose Redis, Cloudflare Durable Objects, or Firestore.
