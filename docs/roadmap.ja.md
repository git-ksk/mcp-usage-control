# Roadmap

このRoadmapは、projectのcore categoryである **MCP tool実行に対するtransactional usage / quota enforcement** を守るためのものです。

core lifecycleは、一般的なrequest rate limitingや実行後usage meteringとは意図的に異なります。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

広いintegrationより先に、このtransaction modelのcorrectnessを優先します。

## v0.1 completion priority

1. **Production multi-round hardening** — `input_required` suspend / resume accounting自体は実装済みです。one-time consume / fail-closed semanticsを弱めず、shared / durable flow-store adapterとpost-claim reconciliationを追加します。Issue #41で追跡します。
2. **Real Cloudflare operational evidence** — deployed Durable Objects adapterについて、残っているcredential rotationと実platform-limit / failure観測を完了します。Issue #24で追跡します。
3. **Public package contract review** — npm publish前にcore / MCP / Redis / Cloudflareのpublic contractをfreezeし、publish gateを明示的に維持します。Issue #6で追跡します。
4. **Failure semantics documentation** — crash recovery、lost / ambiguous ACK、cost liability、multi-round claim / recovery、reconciliation expectationをarchitecture / adapter docsで明示し続けます。

## v0.1以降

### Third-party store invariant kit

usage-store contractを実装するthird-party store向けに、再利用可能なcompatibility test kitを提供します。少なくとも以下を実証できないstoreはcompatibleと主張しない前提にします。

- atomicなall-or-nothing multi-budget reservation;
- idempotent replay behavior;
- pending / cost-liableを区別したexpiry recovery;
- 必要な場合のrenewable / resumable lease behavior;
- conflicting settlement rejection;
- fail-closed storage behavior;
- 必要な場合のauthoritative store-time model;
- ambiguous settlement outcomeの安全な扱い。

### Stable enforcement event contract

observer / event schemaをversion化し、telemetry / billing adapterがtransaction resultへ影響せずenforcement outcomeを利用できるようにします。

observer / exporter failureがadmission / settlement stateを変更できない境界は維持します。

### External billing / metering adapter

次の境界を明示的に維持します。

```text
transactional enforcement core
        -> stable observer/event contract
        -> optional billing/telemetry adapter
```

外部billingやMCP metering specificationは、balance、entitlement、price、invoice、receipt、usage eventなど、coreとは異なるguaranteeを持つconceptを定義する可能性があります。adapterでstableなenforcement outcomeを外部schemaへ変換することはできますが、外部terminology / semanticsによって次を弱めたり置き換えたりしません。

- atomic admission;
- reservation;
- cost-liability state;
- idempotency;
- lease / expiry recovery;
- ambiguous settlementの保守的な扱い。

semanticsが本当に同等でない限り、外部billing protocolに似せる目的だけでcore conceptをrenameしません。

### Policy example

以下のようなatomic combinationについてproduction-oriented exampleを追加します。

- user daily + monthly budget;
- user + tenant budget;
- toolごとのweighted unit;
- free / paid entitlement policy input;
- 必要な場合に別のdurable financial ledgerへreconcileする構成。

## Non-goals

core runtimeは以下にはしません。

- generic HTTP / API rate limiter;
- payment processor / subscription checkout system;
- OAuth / identity provider;
- billing dashboard;
- financial-grade ledger;
- gateway / router product;
- vendor billing protocolそのもののimplementation;
- ambiguousなstate-changing settlement callをblind retryするsystem。

これらとのintegrationは、明示的なadapter / policy boundaryで扱います。
