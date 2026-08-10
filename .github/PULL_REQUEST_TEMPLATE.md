## Summary / 概要

<!-- What changes and why? / 何を、なぜ変更しますか？ -->

## Safety / accounting invariant

<!-- Which invariant is changed or preserved? / どのinvariantを変更・維持しますか？ -->

## Tests / テスト

- [ ] Allowed path / allow path
- [ ] Denied path / deny path
- [ ] Duplicate or retry behavior when relevant / 必要ならduplicate・retry
- [ ] Concurrency behavior when relevant / 必要ならconcurrency
- [ ] Pending vs cost-liable expiry when relevant / 必要ならpending・cost-liable expiry
- [ ] Lease renewal/loss when relevant / 必要ならlease renewal・loss
- [ ] Process-crash recovery when relevant / 必要ならprocess crash recovery
- [ ] Cost-classifier failure/invalid value when relevant / 必要ならcost classifier failure・invalid value
- [ ] Ambiguous storage/settlement acknowledgement when relevant / 必要ならambiguous storage・settlement ACK
- [ ] MCP `isError` / callback-shape / multi-round semantics when relevant / 必要ならMCP `isError`・callback shape・multi-round semantics
- [ ] Official MCP SDK protocol integration test when SDK behavior matters / SDK behaviorが関係する場合は公式MCP SDK integration test
- [ ] `pnpm check`

## Compatibility / 互換性

<!-- Public API, storage state, Node/MCP SDK/Redis compatibility, migrations. / public API、storage state、Node/MCP SDK/Redis互換性、migration。 -->

## Documentation / ドキュメント

- [ ] No user-facing documentation change / user-facing doc変更なし
- [ ] English documentation updated / 英語doc更新済み
- [ ] Japanese documentation updated / 日本語doc更新済み

## Security / セキュリティ

- [ ] No secrets, credentials, cookies, tokens, production identifiers, or private customer data are included. / secret・credential・cookie・token・production identifier・private customer dataを含みません。
- [ ] This PR does not publicly disclose an unfixed vulnerability that belongs in the private SECURITY.md process. / SECURITY.mdのprivate processで扱う未修正脆弱性をpublic disclosureしていません。
