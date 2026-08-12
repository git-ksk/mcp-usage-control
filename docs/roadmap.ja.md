# Roadmap

このRoadmapは、projectのcore categoryである **MCP execution boundaryにおけるfailure-safeなtransactional usage enforcement** を守るためのものです。

core lifecycleは、一般的なrequest rate limiting、実行後usage metering、general-purposeなagent budget platformとは意図的に異なります。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

広いintegrationより先に、このtransaction modelのcorrectnessを優先します。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## Strategic direction

generic agent-budget、gateway、billing、governance productへ広げるのではなく、correctness guaranteeを深くする方針です。

特に維持・強化する差別化は次です。

- metered execution前のatomic admission;
- 明示的な `pending -> cost-liable` boundary;
- execution開始後のconservativeなcrash / expiry behavior;
- lost / ambiguous acknowledgementの安全な扱い;
- logical operationのidempotent replayとconflicting settlement rejection;
- duplicate reservationを作らないMCP-native retry / multi-round continuity;
- 独立して検証できるprovider-neutralなStore semantics。

より広いplatformはdashboard、pricing catalog、組織横断governance、routing、payment flow、multi-language agent integrationなどを提供できます。それらは隣接領域ですが、このruntimeのroadmap templateにはしません。

## Current priorities

1. **Production multi-round hardening** — `input_required` suspend / resume accounting自体は実装済みです。one-time consume / fail-closed semanticsを弱めず、shared / durable flow-storeとpost-claim reconciliationを進めます。Issue #41で追跡します。
2. **Current MCP protocol conformance** — fresh-request multi-round retry semantics、stateless server deployment assumption、long-running Tasks accountingを含め、current MCP protocol / SDK behaviorとの整合を明示的に検証します。stateless-friendlyなMRTR optionを追加する場合も、trusted bindingとaccounting invariantは維持します。
3. **Third-party Store invariant kit** — 外部Storeが同じmethod名を実装しただけでなくsemantic compatibilityを実証できるよう、projectのcorrectness contractを実行可能なtest kitにします。
4. **Real Cloudflare operational evidence** — deployed Durable Objects adapterについて、残っているcredential rotationと実platform-limit / failure観測を完了します。Issue #24で追跡します。
5. **Public package contract review / npm publication** — first registry publicationは明示的にgateしたままにし、publish直前にregistry-facing contract / metadataを最終確認します。Issue #6で追跡します。
6. **Failure semantics documentation** — crash recovery、lost / ambiguous ACK、cost liability、multi-round claim / recovery、task lifetime、reconciliation expectationをarchitecture / adapter docsで明示し続けます。

## MCP-native correctness

protocol-specificな機能は、execution boundaryのaccounting safetyを変える場合にこのprojectへ入れます。

### Multi-round request / response

fresh MCP requestをまたぐ場合でも、1つのlogical operationに対してusage reservationは1つだけ維持します。client経由でround-tripするrequest stateはintegrity verificationを通し、trustedなserver-side principal / tool / argument identityへ再bindingしてからaccounting stateをresumeします。

stateless-friendlyなresume designは、少なくとも次を維持できる場合にのみ検討します。

- logical operationあたり1 reservation;
- 必要な箇所のone-time resume / claim behavior;
- ambiguous state transitionのfail-closed handling;
- trusted principal / tenant / tool / args binding;
- execution開始後のconservative liability semantics。

stateless transportだからaccountingまでstatelessである必要はありません。atomic quota enforcementにshared stateが必要なら利用します。一方で不要なMCP session affinityやgeneric workflow stateは持ち込みません。

### MCP Tasks

long-running Tasksをfirst-class supportと主張する前に、accounting semanticsを定義します。最低限、次を明確にします。

- いつreservationがcost-liableになるか;
- task active中にleaseをどうrenewするか;
- completion / failure / cancellation / abandonmentをどうsettleするか;
- worker / process lossでoptimistic refundを起こさない方法;
- task resultやbusiness-side reconciliationをusage ledgerからどう分離するか。

usage storeをgeneric task / workflow engineにはしません。

## Third-party Store invariant kit

usage-store contractを実装するthird-party Store向けに、再利用可能なcompatibility test kitを提供します。少なくとも以下を実証できないStoreはcompatibleと主張しない前提にします。

- atomicなall-or-nothing multi-budget reservation;
- idempotent replay behavior;
- pending / cost-liableを区別したexpiry recovery;
- 必要な場合のrenewable / resumable lease behavior;
- conflicting settlement rejection;
- fail-closed storage behavior;
- 必要な場合のauthoritative store-time model;
- ambiguous reserve / settlement outcomeの安全な扱い。

このkitでは、concurrency、retry、crash、expiry、ACK ambiguity下でのcorrectnessというprojectの差別化を実際に検証できるようにします。

## Stable enforcement event contract

observer / event schemaをversion化し、telemetry / billing adapterがtransaction resultへ影響せずenforcement outcomeを利用できるようにします。

observer / exporter failureがadmission / settlement stateを変更できない境界は維持します。

## External billing / metering adapter

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

## Policy example

以下のようなatomic combinationについてproduction-oriented exampleを追加します。

- user daily + monthly budget;
- user + tenant budget;
- toolごとのweighted unit;
- free / paid entitlement policy input;
- 必要な場合に別のdurable financial ledgerへreconcileする構成。

## Non-goals

core runtimeは以下にはしません。

- generic agent runtime / agent budget authority;
- generic HTTP / API rate limiter;
- payment processor / subscription checkout system;
- OAuth / identity provider;
- billing dashboard / pricing catalog;
- financial-grade ledger;
- gateway / router product;
- vendor billing protocolそのもののimplementation;
- arbitraryなbusiness side effectをreplayするworkflow engine;
- ambiguousなstate-changing settlement callをblind retryするsystem。

これらとのintegrationは、明示的なadapter / policy boundaryで扱います。
