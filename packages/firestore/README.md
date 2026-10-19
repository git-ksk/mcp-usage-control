# mcp-usage-control-firestore

Server-side Firestore `UsageStore` adapter for [`mcp-usage-control`](https://github.com/git-ksk/mcp-usage-control/tree/main/packages/core#readme).

> **Distribution:** Check the current published version on [npm](https://www.npmjs.com/package/mcp-usage-control-firestore) and find verified source artifacts on [GitHub Releases](https://github.com/git-ksk/mcp-usage-control/releases). For an unreleased source candidate or local tarballs, follow [Use from source](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md).

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

- [Firestore UsageStore](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/firestore.md)
- [Firestore UsageStore 日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/firestore.ja.md)
- [Firestore clock-skew safety](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/firestore-clock-skew.md)
- [Firestore clock-skew safety 日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/firestore-clock-skew.ja.md)
- [Firestore ambiguous acknowledgement semantics](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/firestore-ack-ambiguity.md)
- [Firestore ACK ambiguity semantics 日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/firestore-ack-ambiguity.ja.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.md)
- [Use from source / local tarballs](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md)
- [Source / local tarballから使う](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md)
- [Release policy](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/releasing.md)

## Operation reconciliation (v0.8)

`FirestoreUsageStore` implements optional scalar `OperationReconciliationStore` and v0.13 `VectorOperationReconciliationStore` with read-only Firestore transactions. It validates the deterministic operation document plus expected scalar units or exact vector dimension/budget topology without invoking cleanup/recovery writes. Emulator CI runs the portable scalar and vector reconciliation conformance suites.

## Atomic vector usage (v0.7)

`FirestoreUsageStore` implements optional `VectorUsageStore`. Vector metadata uses additive optional reservation-document fields, so existing scalar documents remain valid without rewrite. Admission/growth/settlement use one Firestore transaction and emulator tests cover portable vector conformance plus committed-growth acknowledgement loss.

## Durable MCP multi-round flow store (v1.3 development candidate)

`mcp-usage-control-firestore/mcp-flow` exports `FirestoreMcpUsageFlowStore`.
It is an **opt-in, server-only** `McpUsageFlowStore` for the MCP adapter's
`protectMultiRoundTool()`; it does not change the Firestore accounting Store or
its schemas. Example:

```ts
import { FirestoreMcpUsageFlowStore } from 'mcp-usage-control-firestore/mcp-flow';
// Use the same authenticated, backend-only Firestore Admin client for all replicas.
const flowStore = new FirestoreMcpUsageFlowStore(adminFirestore, {
  collectionPath: 'muc_mcp_flows',
  expirySafetyMarginMs: 1000,
});
```

- A Firestore transaction reads and conditionally **creates** a flow, then
  compares a trusted binding and **deletes** it on one winner's resume.
  Concurrent retries must not execute billable work twice.
- Expiry is checked against Firestore transaction snapshot `readTime`, not the
  host's wall clock. Missing/invalid server read time is an error (fail closed).
  The default 1-second margin refuses flows too close to expiry; actual
  transaction duration and network/ACK ambiguity must be handled by the
  application, not assumed to be a strict distributed lease clock. Applications
  should use comfortably longer TTLs and bound handler/transaction latency.
- Configure a **Firestore TTL policy on `deleteAt`** in this private collection;
  deletion is asynchronous and is only storage hygiene. `expiresAt` is checked
  for authorization within each transaction. Defaults: 24h retention beyond
  expiry, 64 KiB maximum stored record. Never grant mobile/web clients read or
  write privileges to the collection: records include private lease state.
- `suspend()` or `consume()` can throw after an **ambiguous committed write**.
  The wrapper must fail closed; do not blindly retry the same flow, mint another
  reservation or re-enter business handlers. Store-level idempotence does not
  replace application-owned side-effect fencing or result retention.
- Firestore transactions guarantee one-winner semantics **inside one database**;
  they do not provide HA across distinct projects/databases or control effects
  outside the transaction. Test with an Emulator and official MCP HTTP SDK before
  promoting this development candidate for production.

### MCP複数ラウンドのFirestoreフロー保存（v1.3開発中）

`mcp-usage-control-firestore/mcp-flow` の `FirestoreMcpUsageFlowStore` は、
認証済みサーバー専用の opt-in アダプターです。会計用の既存Firestoreコレクションや
Storeスキーマは変更しません。`suspend()` と `consume()` を単一ドキュメントの
Firestoreトランザクションで実行し、binding照合後の一回限りの取得を保証します。

期限判定はFirestoreトランザクションのスナップショット `readTime` と、
デフォルト1秒の安全マージンを利用します。ホスト時計を正本にはせず、
`readTime` が無ければ安全側に拒否します。ただしコミット遅延・通信途絶・
ACK不明を解消する完全な分散時計/HA機構ではありません。`consume()` が例外を
返した際の無条件再試行や課金対象業務処理の再実行は禁止です。

フロー用コレクションはクライアントSDKからアクセスできないようにし、
`deleteAt` にFirestore TTLポリシーを設定してください。TTL削除は非同期の
容量整理のみで、有効期限の判定には使用しません。デフォルト保持期間は
有効期限後24時間です。公開・本番導入前には実Emulatorと公式SDK E2Eの
受け入れ条件をすべて満たす必要があります。
