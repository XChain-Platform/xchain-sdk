# Contributing to XChain SDK

Thanks for considering a contribution. `xchain-sdk` is the developer SDK for building on the XChain Platform. Downstream applications and wallets use it to construct and sign actions, so we trade speed for correctness on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/sdk) repository (architecture, configuration, action types, lifecycle)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-sdk/
├── index.js              main entry point
├── mcp/                  MCP server (xchain-mcp binary, entry: mcp/cli.js)
├── src/                  SDK core: action builders, encoder client, explorer, wallet, session, repl, api
├── test/                 layered suites (unit, integration, boundary, fuzz, chaos, security, smoke, ...)
├── dist/                 browser bundle output (xchain_sdk.min.js, xchain_sdk.js)
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- No database or coin node is required for unit tests. Integration tests need a running XChain stack (encoder, explorer, hub) reachable from the test environment.

### First-time install

```bash
git clone https://github.com/XChain-Platform/xchain-sdk.git
cd xchain-sdk
npm install
```

Create a `.env` (see [`README.md`](./README.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts. This applies especially to WIF private keys passed through SDK sessions.

---

## Running it

```bash
npm run api        # start the JSON-RPC API server (port from SDK_API_PORT, default 3005)
npm run repl       # interactive REPL with a pre-configured SDK instance
npm run build      # production browser bundle -> dist/xchain_sdk.min.js
npm run build:dev  # development browser bundle -> dist/xchain_sdk.js
```

---

## Tests

The SDK runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services |
|---|---|---|
| Smoke | `npm run test:smoke` | No |
| Unit | `npm test` | No |
| Boundary | `npm run test:boundary` | No |
| Security | `npm run test:security` | No |
| CI (unit, fast gate) | `npm run ci` | No |
| Integration | `npm run test:integration` | Running XChain stack |
| Fuzz | `npm run test:fuzz` | No |
| Chaos | `npm run test:chaos` | No |

Run the no-external-services tiers before every commit. New action-generation or encoding helpers should come with security and fuzz coverage, since a wrong action can cause fund loss in consumers. Changes to the MCP server (`mcp/cli.js`) should include smoke and security coverage for any new tool definitions.

---

## Editing a canonical template (xchain-contracts)

`src/contract/templates.js` is generated, not hand-written: `scripts/sync-templates.js`
embeds the canonical `xchain-contracts` template sources (`escrow`, `vesting`,
`crowdsale`, `amm`, plus everything under `patterns/`) as base64 so
`sdk.scaffold()` can return them from a browser bundle with no `fs` at
runtime. If your change touches a canonical template or pattern in
`xchain-contracts`, you must also run, in this repo, before committing:

```bash
npm run sync:templates
```

and commit the resulting `src/contract/templates.js` diff alongside the
`xchain-contracts` change, as one logical unit.

**Why this is easy to miss.** The drift guard (`test/unit/template-parity.test.js`)
only compares the embed against a canonical source when a sibling
`xchain-contracts` checkout sits beside this repo (`.ci-siblings` declares it;
this repo's own CI checks it out). Without that sibling present the guard
`this.skip()`s cleanly, so a single-repo clone's test run and a solo
`xchain-contracts` PR can both go green while carrying the drift. Only a
combined-tree run, or this repo's own CI, ever actually compares the bytes.

**Push order is canonical-first, and it is not optional.** `xchain-contracts`
is canonical; `xchain-sdk` is a consumer. This repo's CI resolves the
`xchain-contracts` sibling from **its origin**, at whatever ref is currently
pushed there, never from your local edit. So:

- Push (or merge) the `xchain-contracts` change **first**.
- Push the regenerated `xchain-sdk` change **second**, once the canonical
  side is on origin, so the drift guard here compares against the real
  template rather than a stale one.
- If both halves must ship together and the canonical side genuinely cannot
  land first, pair the pushes with the platform's standard cross-repo twin
  mechanism instead of skipping the check: `CI_COMPANIONS="xchain-contracts=<ref>" git push`
  on the SDK side resolves that sibling from your local checkout instead of
  origin. This is the same mechanism every other cross-repo drift guard on
  the platform uses; it is not new machinery, just declaring the ordering
  for this pair.

**Verify locally before either push**, without needing a sibling wired into
a test runner or a full mocha run:

```bash
node scripts/sync-templates.js --check
```

Exits `0` and prints a skip note when no sibling `xchain-contracts` checkout
is present (a normal single-repo clone, not a drift signal). Exits `0` and
confirms the embed matches when a sibling is present and in sync. Exits `1`
with a `TEMPLATE DRIFT` message the moment the embed would differ from what
`npm run sync:templates` would write, so a canonical edit made without
regenerating is caught before it is ever pushed, not just at the CI
boundary.

---

## Coding style

- **Plain JavaScript**, no TypeScript (TypeScript definitions live in `index.d.ts` and are maintained alongside the source). Raw `mathjs` bignumber for all amount and fee calculations; no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, an encoding constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Correctness over speed.** A wrong action string or wrong amount is a fund-loss bug. Be conservative with encoding edge cases and test them explicitly.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the smoke + unit gate. Before opening a PR:

1. Run the no-external-services tiers (`npm run ci`, `npm run test:security`) and confirm they pass.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`, no `dist/` unless you intentionally rebuilt the bundle).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-Platform/xchain-sdk/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
