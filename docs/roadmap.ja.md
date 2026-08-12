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

1. **Production multi-round hardening** — `input_required` suspend / resume accountingは実装済みで、current-protocol proofによりsticky MCP sessionが不要なことも確認済みです。v1では現行のshared / durable compare-and-consume flow stateを採用し、新しいstateless MRTR modeはより強い安全性・運用上の利点をproofできるまでdeferredとします。Issue #41 / #63で追跡します。
2. **MCP Tasks accounting** — long-running accounting state machineは定義・core proof testまで完了しました。upstream Tasks extension / TypeScript surfaceがexperimentalな間はfirst-class protocol adapterをdeferredとし、stable supportとは宣伝しません。Issue #63で追跡します。
3. **Third-party Store invariant kit** — 外部Storeが同じmethod名を実装しただけでなくsemantic compatibilityを実証できるよう、projectのcorrectness contractを実行可能なtest kitにします。
4. **Production-readiness audit** — public API / export / version、Store invariant、security、horizontal scale、tarball / clean-consumer、Node support、CI / release、TODO / Issue、breaking-change候補をv1判定前に最終監査します。
5. **Real Cloudflare operational evidence** — deployed Durable Objects adapterについて、残っているcredential rotationと実platform-limit / failure観測を完了します。Issue #24で追跡し、残件が本当にv1 blockerかも明示的に分類します。
6. **Public package contract review / npm publication** — first registry publicationは明示的にgateしたままにし、publish直前にregistry-facing contract / metadataを最終確認します。Issue #6で追跡します。現在のv1-readiness reviewにnpm publicationは不要で、manual / deferredを維持します。
7. **Failure semantics documentation** — crash recovery、lost / ambiguous ACK、cost liability、multi-round claim / recovery、task lifetime、reconciliation expectationをarchitecture / adapter docsで明示し続けます。

## MCP-native correctness

protocol-specificな機能は、execution boundaryのaccounting safetyを変える場合にこのprojectへ入れます。

### Multi-round request / response

fresh MCP requestをまたぐ場合でも、1つのlogical operationに対してusage reservationは1つだけ維持します。client経由でround-tripするrequest stateはintegrity verificationを通し、trustedなserver-side principal / tool / argument identityへ再bindingしてからaccounting stateをresumeします。

**v1方針**は、atomic compare-and-consumeを持つ現行のshared / durable flow claimです。この方式ですでに、fresh requestが別server instanceへ着地してもsticky MCP sessionなしでresumeできます。

将来stateless-friendlyなresume designを採用する場合も、少なくとも次を維持・proofできることが条件です。

- logical operationあたり1 reservation;
- 必要な箇所のone-time resume / claim behavior;
- ambiguous state transitionのfail-closed handling;
- trusted principal / tenant / tool / args binding;
- execution開始後のconservative liability semantics。

stateless transportだからaccountingまでstatelessである必要はありません。atomic quota enforcementにshared stateが必要なら利用します。一方で不要なMCP session affinityやgeneric workflow stateは持ち込みません。

### MCP Tasks

long-running Tasksのaccounting state machineは [MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) に定義し、`packages/core/src/task-accounting-proof.test.ts` で既存primitiveに対してproofします。

明示したcontractは次です。

- task IDと独立したlogical operationあたり1 admission / reservation;
- task statusからliabilityを推測せず、metered work直前をcost-liable boundaryにする;
- active execution / 意図した `input_required` wait中のlease renewal;
- completion / failure / cancellation / abandonment / worker crash;
- ambiguous reserve / liability / renew / settlement ACKの保守的な扱い;
- cooperative cancellation ACKだけではoptimistic refundしない;
- business operationをblind replayしないreconciliation;
- task / result / worker stateをusage ledgerから分離する。

新しいcore runtime primitiveは不要です。upstream extensionがexperimentalな間はfirst-class MCP Tasks adapterをdeferredとします。public API / docsでstableなprotocol-level Tasks supportを主張しない限り、これはv1 accounting blockerではありません。

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
