import { readFileSync, writeFileSync } from 'node:fs';

const replacements = [
  {
    path: 'README.ja.md',
    from: `**MCP tool実行向けの、同時実行に強いtransactional usage enforcement runtimeです。**

\`mcp-usage-control\` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するprovider-neutral runtimeです。v0.1では、parallel call、retry、failure、長時間handler、process消失があってもadmission / settlementを壊しにくいことを中心にしています。

payment processor、MCP Gateway、OAuth provider、billing dashboard、一般的なrate limiter自体は対象外です。`,
    to: `**MCP toolの利用上限を、同時実行やretryがあっても安全に守るためのライブラリです。**

\`mcp-usage-control\` は、toolを実行する**前**にusage quotaをreserveし、実行後に実際の消費量をsettleします。たとえば「残り1回」のときに2 requestが同時到着しても、両方が同じ残量を使って実行を開始するraceを防ぎます。

扱うのはtool executionとusage accountingの境界です。payment、請求書、subscription管理、OAuth、MCP Gatewayそのものは対象外です。

> 初めて読む場合は **[Getting started](docs/getting-started.ja.md)** から見ると、最小例とMemory / Redis / Cloudflare / Firestoreの選び方を短く確認できます。`,
  },
  {
    path: 'README.md',
    from: `**Concurrency-safe transactional usage enforcement for MCP tool execution.**

\`mcp-usage-control\` is a provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution. v0.1 focuses on correct admission and settlement under concurrency, retries, failures, long-running handlers, and process loss.

It is not a payment processor, MCP gateway, OAuth provider, billing dashboard, or generic rate limiter.`,
    to: `**A library for enforcing MCP tool usage limits safely under concurrency and retries.**

\`mcp-usage-control\` reserves usage quota **before** a tool starts and settles actual usage afterward. If two requests arrive when only one unit remains, they cannot both safely spend the same remaining capacity and start metered work.

The library focuses on the boundary between tool execution and usage accounting. It is not a payment processor, invoicing system, subscription manager, OAuth provider, or MCP gateway.

> First time here? Start with **[Getting started](docs/getting-started.md)** for the smallest example and a quick Memory / Redis / Cloudflare / Firestore comparison.`,
  },
];

for (const { path, from, to } of replacements) {
  const source = readFileSync(path, 'utf8');
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + 1) >= 0) {
    throw new Error(`expected exactly one README intro block in ${path}`);
  }
  writeFileSync(path, source.replace(from, to));
}
