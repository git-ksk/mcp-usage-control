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

The adapter keeps the Firebase / Google Cloud SDK outside its runtime dependency graph by accepting the server Firestore client structurally. It provides transactional multi-budget admission, pending/cost-liable expiry recovery, idempotent settlement, hashed document identifiers, and adapter-local best-effort recovery observer events.

Recovery observation is optional and does not participate in the enforcement transaction:

```ts
const store = new FirestoreUsageStore(getFirestore(), {
  observer: {
    onEvent(event) {
      console.log(event.type, event.recovery, event.reservedUnits);
    },
  },
});
```

## Emulator integration validation

Unit tests use a deterministic structural Firestore fake. A separate `Firestore Integration` GitHub Actions workflow also runs the built adapter against the real Cloud Firestore Emulator through the official `@google-cloud/firestore` server SDK and type-checks that server client against the adapter's structural constructor contract. The package test source keeps the same compile-time constructor compatibility assertion so ordinary `pnpm check` also guards it.

The emulator suite currently covers:

- all-or-nothing multi-budget admission;
- concurrent reservations against one shared tenant budget;
- expired pending reservation recovery and operation-ID reuse;
- cost-liable expiry with conservative reserved-unit retention;
- idempotent settlement replay and release of unused capacity.

For a local run, start the Firestore Emulator so `FIRESTORE_EMULATOR_HOST` is set, build `mcp-usage-control` and this package, then run:

```bash
pnpm --filter mcp-usage-control-firestore test:emulator
```

The test script refuses to run unless `FIRESTORE_EMULATOR_HOST` is present, so it cannot accidentally target production Firestore.

Important production constraints:

- per-user budgets naturally spread across separate documents;
- tenant/global shared budgets intentionally serialize on a shared document and can become contention hotspots;
- active `markLiable()` / `renew()` paths touch only the reservation document so heartbeat traffic does not unnecessarily contend on shared budget documents;
- lease arithmetic uses the application host clock plus an expiry grace rather than Redis-style authoritative server time;
- the v1-supported Firestore profile requires bounded, synchronized host clocks: configure `expiryGraceMs` at least as large as the maximum expected **pairwise positive clock lead** plus measurement margin;
- if the deployment cannot bound host-clock skew, Firestore lease recovery is outside the supported safety claim; use a backend with an authoritative time source rather than treating uncertain expiry as safe capacity;
- choose `ttlMs` well above Firestore transaction/network latency, retry time, heartbeat scheduling interval, and runtime jitter; expiry grace protects against skew and is not a replacement for lease duration;
- do not use Firestore TTL to blindly delete pending reservation documents, because reserved budget capacity must be released transactionally;
- Firestore/store failures and clock-health uncertainty must remain fail-closed and must not be converted into unmetered allow behavior.

See the public guides and reference:

- [Firestore UsageStore](../../docs/firestore.md)
- [Firestore UsageStore 日本語](../../docs/firestore.ja.md)
- [Firestore clock-skew safety](../../docs/firestore-clock-skew.md)
- [Firestore clock-skew safety 日本語](../../docs/firestore-clock-skew.ja.md)
- [Firestore ambiguous acknowledgement semantics](../../docs/firestore-ack-ambiguity.md)
- [Firestore ACK ambiguity semantics 日本語](../../docs/firestore-ack-ambiguity.ja.md)
- [API reference](../../docs/api-reference.md)
- [Use from source / local tarballs](../../docs/using-from-source.md)
- [Source / local tarballから使う](../../docs/using-from-source.ja.md)
- [Release policy](../../docs/releasing.md)
