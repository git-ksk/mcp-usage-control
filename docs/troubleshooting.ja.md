# Troubleshooting

integration自体は動くもののusage behaviorがおかしいときの入口です。

## retryが `duplicate_operation` で拒否される

同じ `operationId` は同じlogical operationにだけ再利用します。duplicate admissionは意図的に拒否されます。guardを回避するためだけに新しいIDを生成しないでください。state-changing ACKをlostした場合は、blind retryではなく、対応Storeのdocumented reconciliation pathを使います。

## error後に `settle(0)` していい？

metered resourceを消費していないとapplicationが証明できる場合だけです。costが発生した可能性があるなら、unknown outcomeをautomatic refundにしません。

## Store障害時にrequestが失敗する

default safety contractです。authoritative Storeのambiguous failureをunmetered allowへ変換しません。Storeを復旧するかproduct boundaryでdenial/errorを扱い、enforcementの外側へgeneric fail-openを追加しないでください。

## long-running toolのleaseがexpireする

metered execution中はleaseをauthoritatively renewする必要があります。supported MCP wrapperの `protectTool()` はheartbeat renewalを行います。Core APIを直接使う場合は、execution durationとStore behaviorに合うrenewal loopが必要です。

## Firestoreのshared quotaでcontentionする

Firestoreは多くのuser-scoped budgetに適しますが、1つのheavily shared budgetはtransaction hotspotになり得ます。[Firestore](firestore.ja.md) のprovider guidanceを確認してください。high-frequency shared quotaはRedisなど別のserialization domainが適する場合があります。

## Memoryでは動くがproduction restartで消える

`MemoryUsageStore` はprocess-local / restart-volatileです。test、example、restart lossを許容するcontrolled single-process deployment向けです。multi-instanceまたはrestart-durable enforcementではshared production Storeを使います。

## 最初にどのpackageを入れる？

MCP TypeScript serverなら、まず `mcp-usage-control` + `mcp-usage-control-mcp` と考えるのが最短です。production Store adapterはdeployment backendを決めてから1つ追加します。npm公開前は [Source / local tarballから使う](using-from-source.ja.md) に従ってください。
