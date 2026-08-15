# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This review records the state of the repository after the post-v0.2.0 MCP correctness and Store-contract work. It is a **release-readiness assessment**, not a v1.0 release instruction.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Verdict

**The source tree is ready to begin a v1.0 release candidate / final release review. No known correctness blocker currently requires a redesign or new runtime feature before v1.0.**

That does **not** mean every optional integration is complete. The project is ready for a v1 API-freeze decision because the stable enforcement boundary is narrow, its failure semantics are explicit, the built-in stores have provider-specific evidence, and third-party store compatibility is now executable.

Before actually creating a v1.0 tag, perform the final release mechanics listed under [Release-time checks](#release-time-checks). Those checks are release hygiene rather than open architecture work.

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

The following are intentionally **not** part of the v1 stable runtime promise:

### First-class MCP Tasks protocol adapter

The accounting state machine is defined and proof-tested in [MCP Tasks accounting](mcp-tasks-accounting.md), including admission, liability, renewal, completion, failure, cancellation, abandonment, worker crash, ambiguous acknowledgements, and reconciliation.

However, the upstream `io.modelcontextprotocol/tasks` TypeScript integration surface remains experimental. The project therefore does not claim a stable first-class Tasks wire/runtime adapter for v1 unless that upstream surface stabilizes before release.

This is not an accounting blocker because the existing core primitives already express the safe task lifecycle. Business task creation, worker ownership, and result replay remain outside `UsageStore`.

### New stateless MRTR resume mode

Deferred. The current shared/durable one-time claim already provides cross-instance resume without sticky sessions. A client-carried/stateless claim would add surface area and is not justified unless it can preserve one-time claim and ambiguous-ACK safety with a concrete operational advantage.

### Stable billing / financial-ledger contract

Deferred/out of scope. Observability and optional downstream billing adapters remain outside the enforcement transaction. The project does not become a financial-grade ledger, payment processor, or billing platform.

### Generic workflow/result replay

Out of scope. Usage accounting may preserve/reconcile its own state, but it does not authorize blind replay of arbitrary business side effects after a crash or ambiguous acknowledgement.

## Production-readiness audit

### Public API / exports / versions

- All five publishable package manifests remain version-aligned at the current source-release line.
- ESM and Node.js 20+ remain the public compatibility floor.
- CI exercises Node.js 20 and 22.
- Public subpath exports are explicitly enumerated and package tarball contents are allow-listed.
- Clean-consumer CI installs all locally packed tarballs and imports the public entry points, including Redis MCP flow and the conformance subpaths.

No v1 version bump is performed as part of this readiness review.

### Store invariant alignment

The built-in stores preserve the same public lifecycle but have different provider-specific implementation boundaries:

- **Memory** — process-local reference implementation; suitable for tests, development, and controlled single-process deployments that explicitly accept restart loss, but not restart-durable or horizontally shared enforcement.
- **Redis** — one Lua transaction domain, Redis server time, concurrency/expiry/replay/ACK-loss evidence; persistence and HA remain deployment-specific.
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain, local workerd tests and real deployed dogfood; remote state-changing ambiguity is surfaced rather than blindly retried.
- **Firestore** — Firestore transactions with hashed storage identifiers; host clock plus documented expiry grace and contention limits.

Third-party implementations should use [Store implementation contract](store-contract.md) and the portable conformance runners. Passing the runner proves behavioral compatibility, not backend durability or failover safety by itself.

### Concurrent admission / replay / crash / expiry / partial failure

Evidence covers:

- concurrent shared-budget admission;
- multi-budget all-or-nothing behavior;
- duplicate logical-operation rejection;
- idempotent liability and terminal settlement replay;
- conflicting settlement rejection;
- pending expiry release;
- liable expiry conservative full retention;
- lease renewal;
- lost reserve / liability / settlement acknowledgements in provider-specific tests;
- one-time multi-round resume and mismatch preservation;
- lost multi-round consume acknowledgement failing closed;
- no automatic business-operation replay after ambiguous execution state.

Cancellation is intentionally conservative. A cancellation request/ACK is not proof of zero cost; zero settlement is valid only when pre-cost cancellation is actually established.

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

### Packaging / clean consumer / Node support

CI validates:

- build + unit/integration tests;
- Node.js 20 and 22;
- Redis 7 integration behavior;
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

The current-protocol fresh-request proof, shared-state MRTR decision, Tasks accounting design/proof, and third-party flow/store contracts now cover the intended acceptance boundary. First-class experimental Tasks adapter work is explicitly deferred rather than silently treated as supported.

### Issue #24 — real Cloudflare operational observations

**Classification: post-v1 operational evidence; not a core v1 blocker.**

Real deployed dogfood has already covered reserve, liability, renewal, settlement, parallel contention, retry, lost ACK, conservative error settlement, fail-closed behavior, and transport/privacy review. The remaining items are execution of the documented real credential-rotation procedure and capture of a genuine platform-limit/overload/Free-plan exhaustion event.

Those observations should remain open and should limit claims such as “proven under every Cloudflare platform-limit condition,” but they do not justify holding the provider-neutral v1 API or core accounting semantics. Do not intentionally burn shared Free-plan quota merely to close the issue.

### Issue #6 — first npm publication

**Classification: deliberately deferred release operation; not a source-readiness blocker.**

The repository should keep stating that packages are not yet available from npm until an explicit publication decision is made. Do not close #6 merely because the source tree is ready for v1 consideration.

## Breaking-change review before v1

No mandatory pre-v1 redesign has been identified. The final API-freeze review should nevertheless confirm these choices because changing them after v1 would be expensive:

1. replay identity remains `(tenantId, principal.id, tool, operationId)`;
2. one quoted/actual unit count applies to every budget participating in one reservation;
3. `actualUnits` may not exceed the reservation;
4. liable expiry retains the full reservation when actual usage is unknown;
5. observer delivery is best-effort/non-transactional;
6. multi-round business result replay remains application-owned;
7. built-in store time/durability differences remain explicit rather than hidden behind a stronger generic guarantee;
8. current public package/subpath names are acceptable for a long-lived stable API.

If any of those are likely to change, change them **before** the v1 tag. No such change is currently required by known correctness evidence.

## Release-time checks

Immediately before an actual v1.0 source release, perform a final mechanical pass:

1. choose the exact release commit and ensure `main` is clean/green;
2. update all five package versions together to `1.0.0` in a dedicated release PR;
3. move only the intended `Unreleased` entries into a new `1.0.0` changelog section without rewriting the historical v0.2.0 section;
4. run full Node 20/22 CI plus Redis, Cloudflare local/workerd, and Firestore integration checks;
5. run package tarball + clean-consumer verification at `1.0.0`;
6. verify README/API docs no longer describe the release candidate as pre-v1 where that wording has become false;
7. inspect the tag-triggered GitHub Release workflow against the exact release commit;
8. only then create the v1.0 source tag/GitHub Release if explicitly authorized;
9. keep npm publication separate unless it receives its own explicit authorization.

## Current decision

**Source/API readiness: GO for v1.0 release-candidate/final-release preparation.**

**Actual v1.0 tag/release: NOT performed.**

**npm publication: NOT performed and still explicitly deferred.**
