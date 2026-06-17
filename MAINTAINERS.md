# Maintainers

This file lists the people responsible for `xchain-sdk`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: the developer SDK and MCP server |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-sdk/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Action generation | Action builders and encoding helpers in `src/actions.js` and `src/formats.js`; the format selector (`src/formatSelector.js`); validation (`src/validator.js`) |
| Transaction lifecycle | `src/lifecycleManager.js`, UTXO chaining (`src/utxoCache.js`), `src/actionWaiter.js` |
| Wallet sessions | `src/walletSession.js`, `src/agentSession.js`, key management (`src/wallet.js`), auth (`src/auth.js`) |
| Encoder integration | `src/encoder.js` (PSBT generation), `src/chunkHelper.js` for chunked DEPLOY |
| Explorer integration | `src/explorer.js` (40+ query endpoints), `src/endpoints.js`, `src/hub.js` |
| Cross-chain helpers | `src/crossChain.js`, XCALL helpers, multi-chain coordination |
| Contracts and VM | `src/contracts.js`, `src/contractClient.js`, `src/contract/` (deploy, execute, deposit, withdraw) |
| Workflows | High-level recipes in `src/workflows.js` |
| Batch builder | Fluent API in `src/batchBuilder.js` |
| WebSocket streaming | `src/websocket.js` (blocks, actions, addresses, markets) |
| Messaging and gated content | `src/messaging.js` (ECIES/ECDH/AES), `src/gatedFile.js` (token-gated file publishing) |
| Attestation helpers | `src/attestation.js` (envelope builders for VM-emitted ATTEST requests) |
| MCP server | `mcp/cli.js` and `mcp/server.js` (the Model Context Protocol server surface) |
| Browser bundle | Browserify build producing `dist/xchain_sdk.min.js` and `dist/xchain_sdk.js` |
| API server | `src/api.js` (JSON-RPC server) |
| Tests | Test suites under `test/` (unit, boundary, fuzz, chaos, round-trip, smoke) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: correct action shapes and format selection, raw parameterized SQL with no ORM, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| An action-generation bug that could make a consumer build a fund-losing action | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- The SDK public API surface: action shapes, method signatures, and format selection behavior.
- The MCP server surface and the published browser bundle.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-encoder`](https://github.com/XChain-platform/xchain-encoder) | The SDK wraps the encoder for PSBT generation; encoding bugs surface here first |
| [`xchain-explorer`](https://github.com/XChain-platform/xchain-explorer) | The SDK wraps the explorer REST/JSON-RPC API for all query methods |
| [`xchain-wallet`](https://github.com/XChain-platform/xchain-wallet) | The reference client wallet is built on top of the SDK |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: ACTION definitions, encoding formats, database naming |

The SDK maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
