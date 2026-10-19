# MCP複数ラウンドの永続化 — 実行可能なプロバイダー別E2E（v1.3候補）

[English](README.md) | [日本語](README.ja.md)

公式MCP TypeScript SDKの`2026-07-28` Streamable HTTPを使い、
`input_required`による中断から**別のHTTPリクエスト・新しいサーバーインスタンス**
による再開までを検証する**開発専用**の実行ランナーです。Redis / Firestore
Emulator / Cloudflareローカルworkerdの本物の永続化基盤を使い、Memoryによる
代用はしません。本番の認証・秘密情報・有料APIは利用しません。

ルートで`pnpm install --frozen-lockfile`と`pnpm build`を実行してください。
**npm公開中の版はv1.2.0のまま**です。新しいv1.3のFlowStore APIは
別途リリース承認されるまでmain内の開発候補です。

## プロバイダーを選んで実行

Redis 7をローカル起動後：

```sh
REDIS_URL=redis://127.0.0.1:6379 node examples/mcp-durable-multi-round/run.mjs redis
```

Redis DB 13とテストごとのランダムprefixを使用します。Redis側`TIME`とLuaの
atomic compare-and-consumeを利用します。本番環境のRedisを指定しないでください。

Firestore Emulatorを別ターミナルで起動します：

```sh
firebase emulators:start --only firestore --project demo-muc-firestore
```

次に：

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-muc-firestore \
  node examples/mcp-durable-multi-round/run.mjs firestore
```

`FIRESTORE_EMULATOR_HOST`未設定なら安全のため拒否します。コレクション名は
試行ごとに別名です。Firestoreのtransaction readTimeと安全マージンを使い、
TTLによる削除は非同期の保管整理のみです。Redisと同じ時計・HA保証はありません。

Cloudflareはクラウド配信せず、隔離された一時保存のworkerdで試します：

```sh
node examples/mcp-durable-multi-round/run.mjs cloudflare --start-workerd
```

テストWorkerのMCPルートはlocalhost・専用フラグ・テスト専用Bearer tokenの
3条件が必要です。会計用DOとFlow用SQLite DOは別々に存在します。
**同じWorker内の直接DO RPCのみ**を確認しており、リモートのFlowStore gatewayを
提供するわけではありません。DOのフロー単位課金/アラーム保持にも注意してください。

`run.mjs all --start-workerd`は3種連続ですが、RedisとFirestore Emulatorは
事前に起動が必要です。未起動の基盤をMemoryへ勝手に置き換えません。

## E2Eが証明する範囲

公式SDKの1回目の`tools/call`で原本`operationId`を予約し、
`input_required`になったあと、2回目の実HTTPリクエストで署名付き
`requestState`を検証します。別MCPサーバーが永続Flow Storeから元の
leaseを**一度だけ**claimして同じ論理操作を再開し、新しい予約を作らず
settleします。同じ操作の再実行は拒否します。各プロバイダーのconformanceでは
別途、16並列競合、テナント/引数照合、期限切れ、ACK喪失を検証します。
全失敗注入マトリクスについては#271を参照してください。

署名された`requestState`はユーザー認証ではありません。principal・tenant・
operation IDは必ずサーバーが決定し、client argumentsを信頼しないでください。
Flowの保存だけで有料処理を再実行する許可にはなりません。
実費発生後にACK喪失した場合は保守的に扱い、client切断で0円返却と
判断しないこと。アプリ側で副作用の冪等化・結果永続化が必要です。

## 基盤比較・本番導入前の確認

| 基盤 | atomic/耐久性の単位 | 時計・整理 | 注意事項 |
| --- | --- | --- | --- |
| Redis | flowごとのLua、単一hash slot | Redis TIME + PXAT | 永続化/HAはRedis設定次第 |
| Firestore | 1データベースの1-document transaction | readTime + `deleteAt`非同期TTL | サーバー専用IAM、遅延/ACK不明 |
| Cloudflare DO | flow IDごとの専用SQLite DO | DO Date.now + alarm、デフォルト24h保持 | 同一Worker RPC、flowごと料金、DO間HA保証なし |

本番での権限・時計差・料金上限・TTL・認証・障害復旧・シークレット更新・
外部業務副作用の冪等性は利用アプリが定義する必要があります。内部Flowや
予算キーを公開ログやMCPエラーに出さないでください。

正式公開後のESM import先は`mcp-usage-control-redis/mcp-flow`、
`mcp-usage-control-firestore/mcp-flow`、
`mcp-usage-control-cloudflare/mcp-flow`、
`mcp-usage-control-cloudflare/mcp-flow-worker`です。
**現行公開v1.2.0にv1.3 APIが既存実装済みだと主張するものではありません。**

注意：`--start-workerd`は`127.0.0.1:8799`を他プロセスが使用中の場合、別Workerに対して「隔離環境で成功」と誤判定しないため停止します。

### 候補tarballを使った新規利用者環境の受け入れ検証（CI）

ソースを直接使う開発者ランナーに加え、各プロバイダーCIは同じ候補バージョンの
`.tgz`を新規npmプロジェクトへインストールして、実Redis / Firestore Emulatorで
公式SDKの複数ラウンドE2Eを実行します。Cloudflareは別の新規npm環境から
パック済みパッケージのDOクラスをimportする専用Workerをローカルworkerdに
起動して動作確認します。これらは**未公開の配布候補**であり、
「npmのv1.3が公開済み」とは主張しません。
