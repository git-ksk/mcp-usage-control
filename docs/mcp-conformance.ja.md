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

## Stateless-friendly MRTRの判断

今回のproofでは新しいstateless MRTR resume modeを追加しません。

現行設計はすでに必要なdeployment propertyを満たしています。fresh protocol requestが別server instanceへ到達してもsticky MCP sessionなしでresumeでき、そのために必要な最小限のauthoritative flow claimだけをshared server-side stateへ残します。

将来stateless-friendlyなrepresentationを採用する場合も、少なくとも次を同じ強さでproofできることが条件です。

- logical operationごとにreservation 1回;
- trusted principal / tenant / tool / args binding;
- one-time claim / consume;
- ambiguous claim ACK後にhandlerへblind re-entryしない;
- cost-liable / crash-expiry behaviorを変えない。

既存のshared compare-and-consume designより強いproofがない段階で新方式を足すと、accounting contractを改善せずsurface areaだけが増えるため、現時点では採用しません。

## Tasksは別工程

今回first-class MCP Tasks supportは追加しません。task lifetime、renewal、cancellation、abandonment、settlement、worker lossのsemanticsをaccounting state machineとして先に定義してから実装判断します。

Task / business resultのreplayもusage ledgerの外に置きます。usage accountingが保証するのはquotaがreserveされ、liableになり、settleされたかどうかまでであり、arbitraryなbusiness side effectをreplayするgeneric workflow engineにはしません。

core failure semanticsは [Architecture](architecture.ja.md)、残るTasks / MCP-native workは [Roadmap](roadmap.ja.md) を参照してください。
