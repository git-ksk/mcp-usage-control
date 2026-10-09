# 実際に起動できるMCPサーバー + クライアント: `protectTool()`

[English](README.md)

公式MCP v2 SDKで**実HTTPサーバーを `127.0.0.1` のOS割当ポートに起動**し、公式MCPクライアントで呼び出す自己検証サンプルです。外部API、課金サービス、認証情報、外部DBは不要です。

クリーンなリポジトリ（Node.js **22+**、pnpm **10.15.0**）で実行：

```sh
pnpm install --frozen-lockfile
pnpm example:mcp
```

正常なら以下のPASSを表示し終了します。アサーション不一致は非ゼロ終了になります。

```text
PASS: real loopback MCP calls settle actual usage; duplicates and exhausted budgets deny before work.
PASS: unknown post-dispatch cost does not silently refund; no business replay.
```

## 検証していること

- 公式`@modelcontextprotocol/server`で`demo-report`を登録し、Streamable HTTP経由で公式`@modelcontextprotocol/client`から呼び出す。サーバーとクライアントは終了時に閉じます。
- 1実行につき**最大5単位**を予約し、**上限8単位**を共有。成功時の実使用量は**3単位**で精算します。成功2回で6単位使用後、次の5単位予約は不可となり、アプリケーションの処理開始**前**に拒否されます。handler入場回数もアサートします。
- 同じ妥当なデモ用アクションUUIDの再送は重複操作として拒否します。ただし**実行済みの結果は再配信しません**。新しいユーザー操作には新しいIDを割り当てます。デモ用UUIDは認可の証明ではありません。製品側にretry-stableな論理操作IDがなければ、通常のreadツールでは**受信dispatchごとにサーバー側の新しいUUID**を使い、独立した転送再試行で再課金が起こり得ることを受け入れます。[論理操作ID](../../docs/mcp-operation-identity.ja.md)参照。
- `unknown-cost`はHandler入場後の障害を模擬します。実際の使用量が不明なら、予約最大値5単位を保守的に精算し、次の5単位要求を拒否します。ゼロ精算には「コストが発生しなかった」確実な証拠が必要です。
- MCPクライアント側では内部例外クラスではなく、**`isError`を含むSDK結果**を検証します。内部のpolicy理由やユーザー識別情報はツール結果に含めません。

## セキュリティと本番適用

`server.mjs`のPrincipalは**固定・全呼出共通のデモ用**です。ローカルloopback上の非破壊的な擬似処理に限り安全です。**このサーバーを公開したり、有料処理にそのまま流用しないでください。** 本番ではアプリケーション側で認証を行い、信頼できるサーバー情報から`tenantId`・Principal・Plan・budget scopeを導出します。業務操作IDのライフサイクル、結果の冪等性、プロバイダ費用の測定もアプリケーションの責務です。

`MemoryUsageStore`は単一プロセスの検証専用で、再起動時に消え、複数レプリカ間で共有されません。本番用には[Redis](../../docs/redis.ja.md)、[Cloudflare Durable Objects](../../docs/cloudflare.ja.md)、[Firestore](../../docs/firestore.ja.md)等から選び、各Storeの時計・耐久性・原子性・フェイルオーバーを別途検証してください。このサンプルだけで分散運用の安全性は証明できません。`input_required`の複数ラウンドには、署名検証された状態と共有atomic flow Storeによる`protectMultiRoundTool()`が必要です（サンプルは単一ラウンドのみ）。

障害・ACK不明の判断は[トラブルシューティング](../../docs/troubleshooting.ja.md)、[操作再照合](../../docs/operation-reconciliation.ja.md)、[インシデント対応](../../docs/incident-response.ja.md)を参照。[CoreのFree/Plus例](../free-plus-credits/README.md)、[入門](../../docs/getting-started.ja.md)、[MCP連携](../../docs/mcp-integration.ja.md)も合わせて参照してください。
