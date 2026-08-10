## Summary / 概要

<!-- What changes and why? / 何を、なぜ変更しますか？ -->

## Safety / accounting invariant

<!-- Which invariant is changed or preserved? / どのinvariantを変更・維持しますか？ -->

## Tests / テスト

- [ ] Allowed path / allow path
- [ ] Denied path / deny path
- [ ] Duplicate or retry behavior when relevant / 必要ならduplicate・retry
- [ ] Concurrency behavior when relevant / 必要ならconcurrency
- [ ] Lease expiry/renewal when relevant / 必要ならlease expiry・renewal
- [ ] Ambiguous storage/settlement failure when relevant / 必要ならambiguous storage・settlement failure
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