# mcp-usage-control-firestore

Server-side Firestore `UsageStore` adapter for [`mcp-usage-control`](../core/README.md).

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or a locally packed tarball until the first registry release.

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { UsageControl } from 'mcp-usage-control';
import { FirestoreUsageStore } from 'mcp-usage-control-firestore';

const store = new FirestoreUsageStore(getFirestore());
const control = new UsageControl(store, policy);
```

The adapter keeps the Firebase / Google Cloud SDK outside its runtime dependency graph by accepting the server Firestore client structurally. It provides transactional multi-budget admission, pending/cost-liable expiry recovery, idempotent settlement, hashed document identifiers, and provider-neutral recovery events.

Important production constraints:

- per-user budgets naturally spread across separate documents;
- tenant/global shared budgets intentionally serialize on a shared document and can become contention hotspots;
- active `markLiable()` / `renew()` paths touch only the reservation document so heartbeat traffic does not unnecessarily contend on shared budget documents;
- lease arithmetic uses the application host clock plus an expiry grace rather than Redis-style authoritative server time;
- do not use Firestore TTL to blindly delete pending reservation documents, because reserved budget capacity must be released transactionally;
- Firestore/store failures must remain fail-closed and must not be converted into unmetered allow behavior.

See the full deployment and contention guidance:

- [Firestore UsageStore](../../docs/firestore.md)
- [Firestore UsageStore 日本語](../../docs/firestore.ja.md)
