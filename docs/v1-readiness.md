# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This review records the state of the repository after the post-v0.2.0 MCP correctness and Store-contract work. It is a **release-readiness assessment**, not a v1.0 release instruction.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Verdict

**The source tree is ready to continue v1.0 API-freeze/finalization work. The additional pre-v1 correctness/evidence gates identified after the original audit are resolved, and none required a redesign of the core transaction model.**

Resolved gates:

- #77 — Firestore ambiguous-commit / acknowledgement-loss semantics;
- #78 — Firestore bounded cross-instance clock-skew safety;
- #79 — Node.js 24 full compatibility-evidence matrix;
- #85 — mutable quota-limit semantics for an existing accounting bucket.

The remaining pre-v1 design work is the explicit #83/#84 boundary decision. Progressive reservation growth and heterogeneous multi-dimensional usage do not need to be implemented before v1, but the project must explicitly accept the current fixed-reservation and same-units multi-budget model as the stable v1 boundary or change it before the tag.

That does **not** mean every optional integration is complete. The stable enforcement boundary is narrow, its failure semantics are explicit, built-in Store support claims now have the required evidence/contracts, and third-party Store compatibility is executable. Optional operational capabilities remain post-v1 candidates.

Before actually creating a v1.0 tag, perform the release-time checks below and obtain explicit release authorization.

## Stable v1 candidate boundary

The following behavior is a candidate for the v1 stable contract:

- `UsagePolicy` quote followed by atomic `UsageStore.reserve()`;
- all-or-nothing multi-budget admission;
- replay identity `(tenantId, principal.id, tool, operationId)`;
- explicit `pending -> cost-liable` transition via `markLiable()`;
- renewable leases;
- conservative expiry after liability;
- terminal settlement with `actualUnits <= reservedUnits`;
- identical settlement replay and conflicting-settlement rejection;
- fail-closed storage semantics;
- same-key mutable effective limits that preserve authoritative reserved/consumed usage;
- `MemoryUsageStore` as a process-local reference implementation;
- Redis, Cloudflare Durable Objects, and Firestore `UsageStore` adapters with their documented deployment constraints;
- `protectTool()` for single-round MCP TypeScript SDK v2 tools;
- `protectMultiRoundTool()` for the currently supported `input_required` multi-round accounting path;
- integrity-verified request-state resume, principal/tenant/tool/args binding, one-time compare-and-consume, and no second quota reservation on resume;
- `RedisMcpUsageFlowStore` for shared/durable multi-round flow claims;
- provider-neutral observability that cannot change enforcement outcomes;
- portable `UsageStore` / `McpUsageFlowStore` conformance runners as behavioral compatibility checks.

The v1 direction for multi-round state is the current **shared/durable compare-and-consume** model. Fresh MCP requests may land on different server instances; sticky MCP session affinity is not required for accounting.

## Experimental / deferred boundary

The following are intentionally **not** part of the v1 stable runtime promise.

### First-class MCP Tasks protocol adapter

The accounting state machine is defined and proof-tested in [MCP Tasks accounting](mcp-tasks-accounting.md), including admission, liability, renewal, completion, failure, cancellation, abandonment, worker crash, ambiguous acknowledgements, and reconciliation.

However, the upstream `io.modelcontextprotocol/tasks` TypeScript integration surface remains experimental. The project therefore does not claim a stable first-class Tasks wire/runtime adapter for v1 unless that upstream surface stabilizes before release.

This is not an accounting blocker because the existing core primitives already express the safe task lifecycle. Business task creation, worker ownership, and result replay remain outside `UsageStore`.

### New stateless MRTR resume mode

Deferred. The current shared/durable one-time claim already provides cross-instance resume without sticky sessions. A client-carried/stateless claim would add surface area and is not justified unless it can preserve one-time claim and ambiguous-ACK safety with a concrete operational advantage.

### Progressive reservation growth and heterogeneous multi-dimensional usage

Issues #83 and #84 are design candidates, not mandatory v1 capabilities. The current candidate contract reserves a bounded maximum before metered work and applies one quoted/actual unit count across every budget participating in one reservation.

Before API freeze, explicitly confirm that these are accepted v1 limitations. Future progressive top-up or per-dimension/vector accounting must preserve atomic admission, replay safety, liability/expiry semantics, and acknowledgement-ambiguity safety and may therefore require a post-v1 additive or major-version contract depending on the chosen design.

### Operational snapshot / reconciliation / threshold helpers

Issues #76, #81, and #82 are post-v1 operational capability candidates. They may compose with authoritative Store results and current observer events, but they must not become a second accounting ledger or turn best-effort telemetry into enforcement authority.

### Stable billing / financial-ledger contract

Deferred/out of scope. Observability and optional downstream billing adapters remain outside the enforcement transaction. The project does not become a financial-grade ledger, payment processor, or billing platform.

### Generic workflow/result replay

Out of scope. Usage accounting may preserve/reconcile its own state, but it does not authorize blind replay of arbitrary business side effects after a crash or ambiguous acknowledgement.

## Production-readiness audit

### Public API / exports / versions

- All five publishable package manifests remain version-aligned at the current source-release line.
- ESM and Node.js 20+ remain the current public compatibility floor.
- Normal full CI exercises Node.js 20, 22, and 24 on the same build/test/package/clean-consumer path.
- The manual npm publication runtime uses Node 24, which is therefore inside normal compatibility evidence rather than being a publish-only runtime.
- Public subpath exports are explicitly enumerated and package tarball contents are allow-listed.
- Clean-consumer CI installs all locally packed tarballs and imports the public entry points, including Redis MCP flow and the conformance subpaths.

No v1 version bump is performed as part of this readiness review.

### Store invariant alignment

The built-in stores preserve the same public lifecycle but have different provider-specific implementation boundaries:

- **Memory** — process-local reference implementation; suitable for tests, development, and controlled single-process deployments that explicitly accept restart loss, but not restart-durable or horizontally shared enforcement.
- **Redis** — one Lua transaction domain, Redis server time, concurrency/expiry/replay/ACK-loss evidence; persistence and HA remain deployment-specific.
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain, portable conformance via local workerd plus real deployed dogfood; remote state-changing ambiguity is surfaced rather than blindly retried.
- **Firestore** — Firestore transactions with hashed storage identifiers; explicit ambiguous-ACK behavior and bounded/synchronized-host-clock deployment contract with deterministic skew evidence. Shared-document contention remains a deployment constraint.

The same mutable-limit contract is now exercised through the portable `UsageStore` conformance runner against Memory, Redis, Cloudflare local workerd, and Firestore Emulator.

Third-party implementations should use [Store implementation contract](store-contract.md) and the portable conformance runners. Passing the runner proves behavioral compatibility, not backend durability or failover safety by itself.

### Concurrent admission / replay / crash / expiry / partial failure

Evidence covers:

- concurrent shared-budget admission;
- multi-budget all-or-nothing behavior;
- same-key limit increase/decrease without resetting authoritative usage;
- concurrent stricter/stale-higher effective-policy views;
- duplicate logical-operation rejection;
- idempotent liability and terminal settlement replay;
- conflicting settlement rejection;
- pending expiry release;
- liable expiry conservative full retention;
- lease renewal;
- provider-specific lost-ACK/retry evidence for Redis, Cloudflare, and Firestore under their documented contracts;
- Firestore multi-instance bounded-skew lease/recovery behavior;
- one-time multi-round resume and mismatch preservation;
- lost multi-round consume acknowledgement failing closed;
- no automatic business-operation replay after ambiguous execution state.

Cancellation is intentionally conservative. A cancellation request/ACK is not proof of zero cost; zero settlement is valid only when pre-cost cancellation is actually established.

### Mutable policy boundary

For the same `budget.key`, the supplied `budget.limit` is the effective admission ceiling for that call, while authoritative used/reserved state remains in the Store.

- increase: existing usage remains counted and only new headroom opens;
- decrease: existing usage/reservations remain and new work denies while at/above the lower limit;
- active reservations are not re-priced or revoked by a policy change;
- settled usage is not refunded by lowering a limit;
- key changes are reserved for genuinely different application-owned accounting buckets/windows;
- `MemoryUsageStore.retireBudgetKey()` is not a plan-change/reset API.

`UsageStore` does not provide distributed policy-version consensus. If application instances concurrently present old/new effective limits, each admission uses the limit supplied by that caller. Strict downgrade cutovers therefore require application-level policy rollout consistency. See [Mutable quota limits](mutable-quota-limits.md).

### Security boundary

- `Principal` is trusted application input derived from authentication/authorization, not a client credential format.
- `operationId` is idempotency input, not identity proof.
- MCP request state is integrity-verified before use and rebound to trusted principal/tenant/tool/args identity.
- Remote Cloudflare requires application-defined authorization and HTTPS outside local tests.
- Firestore is server-side enforcement infrastructure; untrusted clients must not receive direct write authority.
- Raw tool arguments and secrets are not collected by default for enforcement telemetry.
- Hashing of identifiers is privacy minimization, not encryption.

### Horizontal scale

The v1 accounting model supports multiple stateless MCP HTTP handlers as long as authoritative accounting/flow state is shared where required:

```text
HTTP/MCP handlers
    -> shared UsageStore
    -> shared McpUsageFlowStore for multi-round flows
```

Memory stores remain explicitly single-process. Production horizontal scale must use provider-backed shared state.

For Firestore, the supported v1 profile requires bounded, synchronized application clocks with `expiryGraceMs` sized at least to the maximum expected positive pairwise clock lead plus measurement margin. Unknown/unbounded skew is outside the stable Firestore lease-recovery claim.

### Packaging / clean consumer / Node support

CI validates:

- build + unit/integration tests;
- Node.js 20, 22, and 24;
- Redis 7 integration behavior;
- Cloudflare local workerd integration;
- Firestore Emulator integration;
- aligned package versions;
- `npm pack` for all five packages;
- expected tarball files and no leaked source/test artifacts;
- no leaked `workspace:` dependencies;
- installation/import from a clean consumer project.

### Release / npm workflow

GitHub source release and npm publication are deliberately separate operations.

The npm publish workflow is manual-only and requires:

- `workflow_dispatch`;
- an existing release tag;
- explicit `confirm: true` authorization;
- package versions matching the tag;
- a successful test/pack path before publication.

**npm publication remains deferred and must not be run as part of this readiness work.**

## Open issues and blocker classification

### Issue #63 — v1 MCP semantics

**Classification: resolved by the current source tree; not a v1 blocker.**

The current-protocol fresh-request proof, shared-state MRTR decision, Tasks accounting design/proof, and third-party flow/store contracts cover the intended acceptance boundary. First-class experimental Tasks adapter work remains explicitly deferred.

### Issue #24 — real Cloudflare operational observations

**Classification: post-v1 operational evidence; not a core v1 blocker.**

Real deployed dogfood has already covered reserve, liability, renewal, settlement, parallel contention, retry, lost ACK, conservative error settlement, fail-closed behavior, and transport/privacy review. The remaining items are execution of the documented real credential-rotation procedure and capture of a genuine platform-limit/overload/Free-plan exhaustion event.

Those observations limit broad operational claims but do not justify holding the provider-neutral v1 API or core accounting semantics. Do not intentionally burn shared Free-plan quota merely to close the issue.

### Issue #6 — first npm publication

**Classification: deliberately deferred release operation; not a source-readiness blocker.**

Keep stating that packages are not yet available from npm until an explicit publication decision is made. Do not close #6 merely because the source tree is ready for v1 consideration.

### Issues #77 and #78 — Firestore failure/time evidence

**Classification: resolved pre-v1 gates.**

#77 defines fail-closed ambiguous reserve handling and safe same-reservation retry/replay behavior for liability, renewal, and settlement, with post-commit acknowledgement-loss fault injection. #78 defines the bounded/synchronized-clock support envelope and proves cross-instance pending/liability recovery behavior deterministically.

### Issue #79 — Node 24 compatibility evidence

**Classification: resolved pre-v1 release/support-policy gate.**

Node 24 now runs the same full normal CI path as Node 20/22, including build/test, Redis integration, package verification, `npm pack`, and clean-consumer installation/import. The minimum runtime remains Node 20+.

### Issue #85 — mutable quota-limit semantics

**Classification: resolved pre-v1 policy/Store-contract gate.**

The same-key contract preserves authoritative reserved/consumed state across increases/decreases, keeps active reservations intact, denies new work at/above a lower limit, and documents application-owned rollout consistency. Portable conformance verifies the same contract against Memory, Redis, Cloudflare, and Firestore.

### Issues #83 and #84 — future accounting-model extensions

**Classification: post-v1 implementation candidates with a remaining pre-v1 boundary decision.**

Neither progressive reservation growth nor heterogeneous per-dimension units is required to preserve current correctness. Before the v1 API freeze, explicitly document that the stable v1 contract uses a bounded reservation and one common unit count across participating budgets, unless the project intentionally changes those boundaries before the tag.

### Issues #76, #81, and #82 — operational capabilities

**Classification: post-v1 optional capabilities; not v1 blockers.**

Operational snapshots, per-operation status/reconciliation helpers, and quota-threshold signals can improve production usability, but they must remain read-only/non-authoritative with respect to admission and settlement. Existing fail-closed semantics remain valid when a Store cannot prove a resumable status.

## Breaking-change review before v1

The evidence gates now confirm the following stable choices:

- replay identity remains `(tenantId, principal.id, tool, operationId)`;
- liable expiry retains the full reservation when actual usage is unknown;
- observer delivery is best-effort/non-transactional;
- multi-round business result replay remains application-owned;
- built-in Store time/durability differences remain explicit rather than hidden behind a stronger generic guarantee;
- same-key effective-limit changes preserve authoritative usage and do not reset a bucket;
- Firestore stable support uses explicit ambiguous-ACK and bounded-clock contracts;
- the Node runtime support statement is backed by Node 20/22/24 full CI evidence.

The final API-freeze review still must confirm:

1. one quoted/actual unit count applies to every budget participating in one reservation (#84 boundary);
2. `actualUnits` may not exceed the reservation, and reservation growth is not part of the v1 contract (#83 boundary);
3. current public package/subpath names are acceptable for a long-lived stable API.

If any of those need a breaking contract change, make that change **before** the v1 tag.

## Release-time checks

Immediately before an actual v1.0 source release:

1. record the #83/#84 API-freeze decision: fixed reservation and same-units multi-budget remain accepted v1 boundaries unless intentionally changed before release;
2. choose the exact release commit and ensure `main` is clean/green;
3. update all five package versions together to `1.0.0` in a dedicated release PR;
4. move only the intended `Unreleased` entries into a new `1.0.0` changelog section without rewriting historical release sections;
5. run the full Node 20/22/24 matrix plus Redis, Cloudflare local/workerd, and Firestore integration checks;
6. run package tarball + clean-consumer verification at `1.0.0`;
7. verify README/API docs no longer describe the release candidate as pre-v1 where that wording has become false;
8. inspect the tag-triggered GitHub Release workflow against the exact release commit;
9. only then create the v1.0 source tag/GitHub Release if explicitly authorized;
10. keep npm publication separate unless it receives its own explicit authorization.

## Current decision

**Source/API readiness: GO for continued v1.0 API-freeze/finalization.**

**Pre-v1 correctness/evidence gates #77/#78/#79/#85: RESOLVED.**

**Final v1.0 tag/release readiness: GATED only on the explicit #83/#84 boundary decision plus normal release mechanics/authorization.**

**Actual v1.0 tag/release: NOT performed.**

**npm publication: NOT performed and still explicitly deferred.**
