# Security Policy

`xchain-sdk` is the developer SDK for generating XChain actions, and includes an MCP server (`xchain-mcp`, entry point `mcp/cli.js`) for tool-based integrations. Downstream applications and wallets use it to construct and sign actions, so a flaw can cause a consumer to build a wrong or fund-losing transaction. The published browser bundle (`dist/xchain_sdk.min.js`, produced by `npm run build`) extends that surface to browser clients. We treat security reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-Platform/xchain-sdk/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted input, action call, or payload that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the network you tested against (mainnet / testnet / regtest, and which chain).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- Correctness of action generation and encoding helpers in `src/` (wrong action string, wrong amount, misdirected destination, format-version misselection).
- The MCP server surface (`mcp/cli.js`, exposed as the `xchain-mcp` binary): tool definitions, parameter handling, any path where a tool call could produce a wrong or fund-losing action.
- Guidance or handling around key material in SDK consumers: any API that inadvertently leaks, logs, or mishandles private keys or WIF values.
- The browser bundle (`dist/xchain_sdk.min.js`) built by `npm run build`, including supply-chain integrity of that artifact and its Browserify/Babel build pipeline.
- Any path where a malformed or adversarial input to the SDK yields a valid-looking but incorrect transaction.

### Out of scope

- Bugs in applications built on the SDK that misuse its API (that is the application author's responsibility, not an SDK vulnerability).
- The user's key custody and signing environment.
- Vulnerabilities in the underlying chains.
- Compromise of upstream npm dependencies (we mitigate via audit + review, but a backdoor in a dep is the dep author's incident, though we still want to hear about it).
- Misconfiguration of the operator's own service endpoints or network exposure.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` or `testnet` where possible (the `xchain-regtest-miner` plus a local stack make this easy). Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
