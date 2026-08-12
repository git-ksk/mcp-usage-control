# Security Policy

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Supported versions

security fixのsupport対象はlatest GitHub/source minor lineです。このpolicyではv0.2.xをcurrent supported source-release lineとし、v0.1.xをsupersedeします。npm registry publishは別工程なので、GitHub/source releaseをsupportしていてもnpm公開はdeferできます。

## 脆弱性の報告

quota bypass、double spending、unauthorized entitlement access、cross-tenant accounting access、replay abuse、inconsistent settlement、または発生済みworkをcrash/failure経由でfree usageへ変えられる問題は **public Issueへ投稿しないでください**。

利用可能な場合はGitHub private vulnerability reportingを使ってください。有用なreportにはaffected commit/version、minimal reproduction、expected invariant、observed behavior、必要なconcurrency/retry/expiry/storage failure条件、impact、workaroundを含めます。

production credential、user data、access token、cookie、secretは含めないでください。

## Security-sensitive invariants

次の領域を変更する場合は、必要に応じduplicate / concurrent callを含むtestでinvariantを示してください。

- admission / quota comparison
- reservation creation
- pending -> cost-liable activation
- renewable lease / expiry recovery
- execution開始後のprocess crash recovery
- operation idempotency / tombstone
- settlement / unused-unit release
- success / tool-error / thrown-error cost classifier
- principal / tenant scoping
- MCP multi-round suspend/resume binding / one-time consume
- Redis atomicity / transaction-domain assumption
- Firestore transaction / server-side authorization boundary
- ambiguous acknowledgement handling
- storage failure behavior
- user/model-visible denial message
- observability hook / metadata redaction boundary

production storeでquota enforcementを分離した `check` と `record` として実装してはいけません。ambiguous storage failureでは、applicationが明示的に別availability policyを選択・documentしない限り新規admissionをfail closedにします。

## Cost-liability boundary

reservationはpendingで開始し、metered execution boundaryへ入る前だけexpiry時に解放できます。`markLiable()` 成功後のexpiryはprocess crashをrefundへ変えてはいけません。現在のreference behaviorではfull reservationをchargeします。

generic MCP adapterはhandler entry直前にleaseをcost-liableへ遷移させます。これは意図的に保守的です。applicationがliability boundaryを後ろへ移す場合、crash-after-cost quota bypassを作らないことを保証する必要があります。

`successUnits`、`toolErrorUnits`、`errorUnits` はtrusted enforcement stateではありません。classifierがthrowまたはinvalid unitsを返した場合、MCP adapterはfull reservationをsettleした後 `UsageClassificationError` を表面化します。

## Trust boundaries

`mcp-usage-control` 自体はcaller authenticationを行いません。applicationはtrusted authentication / authorization stateから `Principal` を導出し、model/user suppliedのplan / tenant identifierをverificationなしで信用してはいけません。

`operationId` はidempotency inputでありcredentialではありません。同一logical invocationのretryではstableである必要がありますが、identity proofとして扱ってはいけません。

`UsageDeniedError.reason` にはinternal policy informationが含まれる可能性があります。MCP SDKのerror conversionで自動露出しないようthrow messageは意図的にgenericです。user-visible messageへ変換する場合はallowlist等の明示的safe mappingを使ってください。

built-in MCP lease heartbeatはprovider-specific fencingではありません。lease loss直後に処理停止が必要なapplicationはmetered resource boundaryでfencing / cancellationを実装してください。

## Observability boundary

`UsageObserver` はoperational telemetryであり、trusted enforcement stateでもdurable financial ledgerでもありません。observerの成功/失敗によってadmission、quota release、settlementを決めてはいけません。

tool argumentsとraw exception messageは自動収集しません。`operation.error.errorName` はmutableな `Error.name` やexception messageではなく、boundedなconstructor class名を使います。custom `metadata` は明示opt-inでusage requestを受け取れるため、secret、token、raw tool arguments、provider payload、無制限なuser contentをコピーしない責任はapplication側にあります。

runtime eventにはprincipal、tenant、operation、reservation、tool、budget identifierが含まれる場合があります。potentially sensitive / high-cardinality dataとして扱ってください。unique principal / operation / reservation / user-specific budget identifierをmetric label/tagへ使わず、structured log / traceには適切なretention / access controlを適用してください。

operational structured logには `projectUsageEvent()` を優先してください。default projectionではidentity、reservation / operation ID、tool / budget identifier、settlement outcome string、unrestricted application reasonを除外します。projected metadataを有効にする場合もexplicit opt-inであり、caller supplied metadataが自動的にsafeになるわけではありません。

Redis lazy recoveryはtelemetry改善のためだけにraw request identityを永続化しません。そのためrecovery eventはaggregate-onlyになる場合があります。observability lossを「enforcementが起きなかった証拠」として扱わないでください。

## MCP multi-round flow

`protectTool()` はsingle-roundのままで、v2 `input_required` をrejectします。suspend/resume accountingが必要なapplicationは `protectMultiRoundTool()` を明示的にopt-inしてください。

wire `requestState` はMCP server側でverifyするintegrity-protection schemeを使ってmintする必要があります。wrapperが受け入れるのはSDK verification hookによって既にdecodeされたpayloadだけで、raw / malformed / unverified stateはfail closedします。`UsageLeaseResumeState` はtrusted server-side stateであり、untrusted clientへcredential / bearer tokenとして渡してはいけません。

suspended flowはprincipal、optional tenant、tool、original argumentsのhashへbindingします。`McpUsageFlowStore.consume()` はそのbindingをcompareし、matching flowだけをatomicにconsumeする必要があります。mismatchで正当なflowをconsumeしてはいけません。`MemoryMcpUsageFlowStore` はprocess-localなので、horizontal scaling時は `RedisMcpUsageFlowStore` のようなatomic compare-and-consume semanticsを持つdurable storeを使ってください。

Redis MCP flow storeはbinding-aware Lua operationとRedis server-time expiryを使います。missing / expired / replayed / mismatched flowはfail closedします。ambiguous / lost consume ACKもfail closedし、不確実なconsume resultの後に新しいoperation IDを生成してapplication workへ再入場してはいけません。

multi-round workはhandler entry前にcost-liable化します。resume時はquotaを再reserveせず既存reservationをrenewします。flow claim後にprocessが消失した場合、expiryはfull reserved chargeを保守的に維持します。

## Cloudflare remote-store boundary

Cloudflare adapterのpublic HTTP gatewayはapplication-defined authorization callbackを必須とし、unauthenticated defaultを持ちません。local以外のremote clientはHTTPS必須で、URLへ埋め込んだcredentialもrejectします。timeout / lost ACKはambiguousなのでblind automatic retryで隠してはいけません。

operation / budget / settlement-outcome identifierはCloudflare backend boundary前にhash化し、tool argumentsは送りません。hashingはencryptionではなく、secretを含むidentifierを安全にするものではありません。

## Firestore store boundary

Firestore adapterはserver-side enforcement infrastructureです。untrusted clientへbudget / reservation collectionのdirect write accessを与えたり、configurable collection prefixをauthorization boundaryとして扱ってはいけません。

reserve、settlement、expiry recoveryはFirestore transactionでenforcement stateを更新します。expired pending reservationはcapacityを解放し、expired liable reservationは保守的chargeを維持します。lease expiryはhost-clock timestamp + configurable grace periodを使うため、deploymentではclock skewと強く共有されるbudget documentのcontentionを考慮してください。

budget key / operation identity tupleはFirestore document IDになる前にSHA-256 hash化します。hashingはaccidental identifier disclosureを減らしますがencryptionではありません。identifierへsecretを入れないでください。Firestore IAM / Security Rulesとserver credential管理はapplication / deployment側の責任です。

## Redis durability boundary

Redis Luaはatomic transitionを提供しますがfinancial-ledger durabilityを保証するものではありません。persistence、replication、failover設定によってacknowledged accounting stateがinfrastructure failure後も残るかが変わります。

operatorはrisk toleranceに合ったRedis HA / persistenceを選定してください。durable financial reconciliationが必要ならRedis enforcement stateとは別にdurable ledger / event pathを持ってください。durability failureによってspendable quotaが系統的に復活する場合はsecurity-sensitiveとして扱います。

## Secret handling

contributorがsecretをcommitする必要はありません。example、test、log、Issue template、documentationはplaceholder / synthetic identifierを使います。

Redis keyではprincipal / operation / budget identifierをhash化しますが、hashはencryptionではありません。identifier、event metadata、settlement outcomeにsecretを入れないでください。

## Disclosure

public disclosure前にreproduce / assessする時間を確保してください。fix公開後のsecurity release noteではaffected version、impact、remediationを説明し、無関係なprivate informationは含めません。
