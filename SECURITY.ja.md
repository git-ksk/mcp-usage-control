# Security Policy

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Supported versions

このprojectは現在pre-alphaです。最初のtagged releaseまではlatest `main` branchのみをsupportします。

tagged release開始後は、support対象versionをこのdocumentへ明示します。

## Vulnerabilityの報告

quota bypass、double spending、unauthorized entitlement access、cross-tenant accounting access、replay abuse、inconsistent settlementにつながる可能性があるvulnerabilityを**public Issueへ投稿しないでください**。

利用可能な場合は、このrepositoryのGitHub private vulnerability reportingを使用してください。reportには次があると調査しやすくなります。

- affected commit / version
- minimal reproduction
- expected safety invariant
- observed behavior
- concurrent call、retry、expiry、storage failureが必要か
- impactと既知のworkaround

reportへ無関係なproduction credential、user data、access token、cookie、secretを含めないでください。

## Security-sensitive invariant

次の領域を変更する場合は、必要に応じてduplicate / concurrent call下でもinvariantを示すtestが必要です。

- admission / quota comparison
- reservation creation
- renewable lease / expiry recovery
- operation idempotency / tombstone
- settlement / unused-unit release
- principal / tenant scoping
- Redis atomicity / transaction-domain assumption
- ambiguous acknowledgement handling
- storage failure behavior

production storeでquota enforcementを別々の `check` と `record` operationとして実装してはいけません。ambiguous storage failure時の新規admissionは、applicationが別のavailability policyを明示的に選びdocumentしない限り、fail closedとします。

## Trust boundary

`mcp-usage-control` 自体はcallerをauthenticateしません。applicationは信頼できるauthentication / authorization stateから `Principal` を導出し、modelやuserが送信したplan / tenant identifierをverificationなしで信用してはいけません。

`operationId` はidempotency inputでありcredentialではありません。同一logical invocationのretryではstableにし、identityの証明として扱わないでください。

built-in MCP lease heartbeatはprovider-specific fencingではありません。lease loss後に即座のcancelが必要なapplicationは、metered resource boundaryでfencing / cancellationを実装してください。

## Secret handling

contributorがsecretをcommitする必要がある設計にしません。example、test、log、Issue template、documentationではplaceholderまたはsynthetic identifierを使用してください。

Redis keyではprincipal / operation / budget identifierをhash化しますが、hashingはencryptionではありません。identifierやsettlement outcomeにsecretを入れないでください。

## Disclosure

public disclosure前にreproduce / assessmentの時間を確保してください。fix公開後のsecurity release noteではaffected version、impact、remediationを説明し、無関係なprivate informationは公開しないでください。