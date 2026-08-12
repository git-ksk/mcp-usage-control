# MCP protocol conformance

[English](mcp-conformance.md) | [日本語](mcp-conformance.ja.md)

この文書は、現在のMCP adapterがprotocol levelでaccounting invariantを守れていることを記録します。新機能を増やすことが目的ではありません。現在のMCP multi-round request / response behaviorでも、既存のtransactional accounting modelが崩れないことをproofするための文書です。

## 検証するbaseline

repositoryのtestでは現在、`@modelcontextprotocol/client` と `@modelcontextprotocol/server` を `2.0.0` にlockしています。current conformance integration testではlegacy fallbackへ依存せず、MCP protocol revision `2026-07-28` を明示的にpinします。

検証経路はofficial SDKそのものです。

```text
Client
  -> StreamableHTTPClientTransport
  -> createMcpHandler
  -> McpServer
  -> protectMultiRoundTool()
```

protocol固有のstateは `mcp-usage-control-mcp` より下のcore `UsageStore` contractへ持ち込みません。

## Fresh-request multi-round proof

`packages/mcp/src/current-protocol.integration.test.ts` では、1つのprotocol exchangeの中で次を確認します。

1. clientはprotocol revision `2026-07-28` をpinして接続し、`modern` eraになる;
2. round 0は1つ目の `createMcpHandler` instanceへ入り、`input_required` を返す;
3. SDKは同じlogical tool callをfresh MCP requestとしてretryする;
4. round 1は意図的に別の `createMcpHandler` instanceへroutingする;
5. 2回のhandler entryでMCP request IDが異なる;
6. logical operationに対するpolicy quote / reservationは1回しか行われない;
7. resume roundは元のusage leaseへ再接続し、完了時のsettlementで未使用reservationを解放する。

重要なのは、**fresh MCP requestだからといってfresh usage reservationを作らない**ことです。

## Horizontal scaleとsession affinity

multi-round accountingのためにsticky MCP sessionは要求しません。resume authorityは前roundを処理したHTTP handlerのidentityではなく、shared accounting stateから得ます。

conformance testでは2つの独立したhandler instanceをまたいでresumeし、usage controllerとflow storeだけを共有します。これにより、handler-localなMCP session stateへ依存していないことを確認します。

実際のmulti-process / horizontally scaled deploymentではprocess-localなMemory storeだけでは不十分です。accounting boundaryの両側でauthoritativeなshared stateが必要です。

- reservation、liability、renewal、settlementを管理するshared / durable `UsageStore`;
- binding-awareなatomic compare-and-consume semanticsを持つshared / durable `McpUsageFlowStore`。このflow state向け実装として `RedisMcpUsageFlowStore` を提供しています。

つまり、stateless transportは **stateless accountingを意味しません**。session affinityを不要にしつつ、transactional invariantを守るために必要なauthoritative stateは維持します。

## Resume-state safety matrix

| Invariant | 仕組み | Proof |
| --- | --- | --- |
| wire stateのintegrity verification | wrapperはMCP serverの `requestState.verify` hookがdecodeしたobjectだけを受け入れ、raw client-controlled stringはfail closedする | `packages/mcp/src/index.test.ts` でraw unverified `requestState`を拒否 |
| principal / tenant / tool / args binding | suspended stateをtrusted `principalId`、optional `tenantId`、tool名、original argsのhashへbindingする | `McpUsageFlowStore.consume()` がfull bindingをatomic compareし、Memory / Redis testでmismatch後も正当なstateを保持 |
| logical operationごとにreservation 1回 | stateなしのinitial entryだけが `control.reserve()` を呼び、verified resumeはtrusted server-side lease stateを `control.resumeLease()` する | current-protocol integration testでfresh request 2回・handler instance 2つでもquoteは1回 |
| one-time resume | matching flow tokenをconsume時にatomic removeする | Memory concurrent replayではapplication handlerへ1回だけ入り、Redis contentionでもconsumerは1つだけ |
| mismatchで正当なstateを失わない | binding一致後にだけstateをremoveするcompare-and-consume | Memory principal mismatch / Redis binding mismatchの後でも正当なbindingでconsume可能 |
| ambiguous consume ACKはfail closed | consume errorをそのまま表面化し、wrapper側でretryやapplication workへの再入場を行わない | Redis lost-consume-ACK testでcommit済みconsume tokenが再利用できないことを確認 |
| crash / abandonment後もcost liability維持 | initial metered work前にliable化し、resumeではalready-liable leaseへ再接続する | abandoned suspended-flow testでexpiry後もconservative chargeを保持 |

これらは独立した保証ではなく、組み合わせて守る必要があります。特にshared flow claimを単純なclient-carried stateだけへ置き換えても、one-time consumeやlost consume ACKの安全性は証明できません。

## v1に向けたStateless-friendly MRTRの判断

**v1では現行のshared / durable compare-and-consume方式を採用します。新しいstateless MRTR resume modeはv1 boundaryへ追加しません。**

現行設計はすでに必要なdeployment propertyを満たしています。fresh protocol requestが別server instanceへ到達してもsticky MCP sessionなしでresumeでき、そのために必要な最小限のauthoritative flow claimだけをshared server-side stateへ残します。

client-carried stateなどのstateless-friendly方式を採用するなら、concurrencyとACK ambiguityの下でも次を同じ強さでproofする必要があります。

- logical operationごとにreservation 1回;
- trusted principal / tenant / tool / args binding;
- one-time claim / consume;
- ambiguous claim ACK後にhandlerへblind re-entryしない;
- cost-liable / crash-expiry behaviorを変えない。

現時点ではshared claimを置き換えるだけのcorrectness上・運用上の明確な利点が証明されていません。v1前に追加するとaccounting contractを改善せずsurface areaだけ増えるため、**deferred** とします。v1 blockerではありません。

## Tasks accounting

長時間実行するTasksのaccounting state machineは [MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) に定義しました。

既存core invariantをそのまま守ります。

- task IDとは独立してlogical operationごとにreservation 1回;
- `working` からliabilityを推測せず、metered work直前に `markLiable()`;
- 長時間の `working` / `input_required` 中はserver-sideで同じleaseをrenew;
- `tasks/cancel` ACKだけではrefundしない;
- pending worker lossはexpiryで解放し、liable worker lossはreservationを保守的に保持;
- identical terminal settlement replayはidempotentにできるが、conflicting replayはfail closed;
- business task creation/result replayやworker ownershipは `UsageStore` の外に置く。

`packages/core/src/task-accounting-proof.test.ts` では既存lease/store primitiveだけを使ってこれらをproofします。新しいcore runtime APIは不要です。

2026-08-13時点では `io.modelcontextprotocol/tasks` extensionとTypeScript integration surfaceはstable TypeScript SDK coreとは別に管理され、upstreamでも明示的にexperimentalです。そのためstableなfirst-class MCP Tasks adapterはまだ宣言しません。README/package docsでprotocol-level Tasks supportをdeferred / experimentalと明記する限り、これはv1のaccounting blockerではなくintegration boundaryです。

core failure semanticsは [Architecture](architecture.ja.md)、残るv1-readiness workは [Roadmap](roadmap.ja.md) を参照してください。
