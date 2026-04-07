<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform - Software Developer Kit (SDK)

<p align="center">
  <img src="https://img.shields.io/badge/version-1.4.3-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-551%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20fuzz%20%7C%20chaos%20%7C%20boundary%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

Developer-facing SDK for generating XChain platform transactions and querying blockchain data.

## Features

- **19 ACTION types** — `sdk.send()`, `sdk.issue()`, `sdk.mint()`, and 16 more convenience methods
- **Automatic format selection** — picks the smallest encoding format for every action
- **PSBT generation** — integrates with xchain-encoder to produce unsigned transactions
- **40 explorer endpoints** — balances, tokens, transactions, markets, history
- **Batch builder** — fluent API: `sdk.batch().send({...}).mint({...}).build()`
- **Hub discovery** — auto-resolves service endpoints from xchain-hub
- **Retry with backoff** — handles HTTP 429/502/503/504, respects `Retry-After` headers
- **Request hooks** — `onRequest`, `onResponse`, `onError`, `onRetry` callbacks
- **TypeScript definitions** — full `.d.ts` for IDE autocomplete
- **Browser bundle** — Browserify build for client-side use
- **551 tests** — unit, boundary, fuzz, chaos, round-trip, and smoke

## Documentation

Full SDK developer guide is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/sdk) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/README.md) | Overview, installation, usage modes |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/CONFIGURATION.md) | Constructor options, env vars, hub discovery, retry, pooling, hooks |
| [Actions](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/ACTIONS.md) | All 19 ACTION types — params, validation rules, format versions, examples |
| [Explorer](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/EXPLORER.md) | All 40 query methods — balances, tokens, transactions, markets |
| [Encoder](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/ENCODER.md) | PSBT generation — encoding types, options, pre-flight validation, P2SH two-phase |
| [Batch Builder](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/BATCH.md) | Fluent API for multi-action transactions |
| [Format Selection](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/FORMAT_SELECTION.md) | How the SDK picks the optimal format version |
| [Errors](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/ERRORS.md) | All error classes, codes, and troubleshooting |
| [Examples](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/EXAMPLES.md) | 29 end-to-end code examples |

## Quick Start

```js
const { XChainSDK } = require('xchain-sdk');

const sdk = new XChainSDK({
    network: 'bitcoin-mainnet',
    explorerUrl: 'explorer.xchain.io',
    encoderUrl: 'encoder.xchain.io'
});

// Generate an action string
const result = await sdk.send({
    tick: 'MYTOKEN',
    amount: '100',
    destination: 'bc1q...',
    memo: 'Payment'
});
console.log(result.actionString); // 'SEND|0|MYTOKEN|100|bc1q...|Payment'

// Generate a PSBT (ready for signing)
const tx = await sdk.send(
    { tick: 'MYTOKEN', amount: '100', destination: 'bc1q...' },
    { pubkey: 'your-pubkey' }
);
console.log(tx.psbt);     // '70736274ff...'
console.log(tx.encoding); // 'OP_RETURN'

// Query blockchain data
const balances = await sdk.getBalances('bc1q...');
const token = await sdk.getToken('MYTOKEN');
```

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start JSON-RPC server (port from `SDK_API_PORT`, default 3005) |
| `npm test` | Run all 551 tests |
| `npm run build` | Production browser bundle → `dist/xchain_sdk.min.js` |
| `npm run build:dev` | Development browser bundle → `dist/xchain_sdk.js` |

## Test Suite

| Type | File | Tests |
|---|---|---|
| Unit | `actions.test.js` | 70 — all 19 actions, format selection, introspection |
| Unit | `validator.test.js` | 95 — field validation, BATCH constraints |
| Unit | `formatSelector.test.js` | 60 — version selection, serialization |
| Unit | `explorer.test.js` | 57 — coin prefixes, URLs, pagination, errors |
| Unit | `encoder.test.js` | 34 — JSON-RPC payloads, validation, errors |
| Boundary | `boundary.test.js` | 36 — exact limits (OP_RETURN 76/77 bytes, TICK 250/251, etc.) |
| Fuzz | `fuzz.test.js` | 56 — garbage types, unicode, prototype pollution |
| Chaos | `chaos.test.js` | 28 — malformed responses, HTTP errors, timeouts |
| Round-trip | `roundtrip.test.js` | 29 — serialize → parse → verify for all actions |
| Smoke | `smoke.test.js` | 11 — boot API server, end-to-end JSON-RPC |
| Unit | `convenience.test.js` | 40 — convenience methods, BatchBuilder |
| Unit | `retry.test.js` | 35 — retry logic, Retry-After, hooks |
| **Total** | | **551** |

---

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
