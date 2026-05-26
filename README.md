<!-- SPDX-License-Identifier: LicenseRef-Dankest-Community -->
<!-- Copyright © 2025 Dankest, LLC -->

# XChain Platform - Software Developer Kit (SDK)

<p align="center">
  <img src="https://img.shields.io/badge/version-1.8.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/tests-520%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node">
  <img src="https://img.shields.io/badge/license-Dankest%20Community-orange" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20fuzz%20%7C%20chaos%20%7C%20boundary%20%7C%20smoke-brightgreen" alt="Coverage">
</p>

Developer-facing SDK for generating XChain platform transactions and querying blockchain data.

## Features

- **29 ACTION types** — `sdk.send()`, `sdk.issue()`, `sdk.mint()`, `sdk.stake()`, and 25 more convenience methods
- **Transaction lifecycle** — `sdk.submitAction()` handles the full encode → sign → broadcast → wait pipeline in one call
- **Wallet sessions** — `sdk.session(wif)` bundles address/key/UTXO state for repeated actions from one address
- **Fee estimation** — `sdk.estimateFees()` returns fee info without signing or broadcasting
- **UTXO chaining** — in-memory UTXO cache prevents double-spend on rapid sequential transactions
- **Workflow recipes** — `sdk.issueAndDistribute()`, `sdk.deployAndFund()`, `sdk.stakeAndDelegate()`, and more
- **Cross-chain helpers** — coordinate swaps and parallel actions across BTC, LTC, and DOGE SDK instances
- **Event-driven confirmation** — `sdk.waitForAction(txid)` resolves when the indexer processes a transaction
- **Interactive REPL** — `npm run repl` drops into a live session with a pre-configured SDK instance
- **Automatic format selection** — picks the smallest encoding format for every action
- **PSBT generation** — integrates with xchain-encoder to produce unsigned transactions
- **40+ explorer endpoints** — balances, tokens, transactions, markets, history, contracts
- **Batch builder** — fluent API: `sdk.batch().send({...}).mint({...}).build()`
- **Real-time events** — WebSocket streaming with `onBlock()`, `onAction()`, `onAddress()`, and more
- **Encrypted messaging** — ECIES, ECDH, and AES encryption for MESSAGE actions; `messaging.send()` accepts a `Buffer` payload and `getMessages()` exposes `msg.bytes` for binary ECIES
- **Token-gated file publishing** — `sdk.gatedFile.encryptFileBytes()` and `sdk.gatedFile.encryptPack()` produce AES-256-GCM ciphertext + key for FILE v1 gated content; key handoff as a compact 33-byte binary payload via `serializeKeyPayload()` / `parseKeyPayload()` (sent through ECIES in binary mode). See [Token-Gated Content](https://github.com/XChain-platform/xchain-documentation/blob/master/protocol/TOKEN_GATED_CONTENT.md)
- **Attestation envelope helpers** — `AttestationHelpers.llm({...})` builds the JSON envelope a VM contract passes to `xchain.attestation.request(...)` with provider_id `'llm'`; `AttestationHelpers.httpGet({url})` validates the URL and returns the payload string for `'http_get'`; `AttestationHelpers.requestOptions({redundancy, deadlineBlocks})` builds the gateway options object
- **Token-ownership trading helpers** — `ORDER`/`SWAP`/`DISPENSER` v0 carry `GIVE_OWNERSHIP` / `GET_OWNERSHIP` flags; `SWEEP` carries independent `ORDERS` / `SWAPS` / `DISPENSERS` flags (was a single `ESCROWS` flag)
- **Wallet & auth** — key management, PSBT signing, challenge-response verification
- **Smart contracts** — deploy, execute, deposit, withdraw via xchain-vm integration
- **Hub discovery** — auto-resolves service endpoints from xchain-hub
- **Retry with backoff** — handles HTTP 429/502/503/504, respects `Retry-After` headers
- **Request hooks** — `onRequest`, `onResponse`, `onError`, `onRetry` callbacks
- **TypeScript definitions** — full `.d.ts` for IDE autocomplete
- **Browser bundle** — Browserify build for client-side use

## Documentation

Full SDK developer guide is available in the [xchain-documentation](https://github.com/XChain-platform/xchain-documentation/tree/master/components/sdk) repository:

| Document | Description |
|---|---|
| [README](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/README.md) | Overview, installation, usage modes |
| [Configuration](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/CONFIGURATION.md) | Constructor options, env vars, hub discovery, retry, pooling, hooks |
| [Actions](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/ACTIONS.md) | All 29 ACTION types — params, validation rules, format versions, examples |
| [Transaction Lifecycle](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/LIFECYCLE.md) | submitAction, fee estimation, UTXO chaining, P2SH two-phase handling |
| [Wallet Sessions](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/SESSIONS.md) | Bound wallet sessions, convenience methods, UTXO cache |
| [Workflows](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/WORKFLOWS.md) | High-level recipes: issueAndDistribute, deployAndFund, stakeAndDelegate |
| [Cross-Chain](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/CROSSCHAIN.md) | Multi-chain coordination: parallel actions, swaps, links |
| [Explorer](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/EXPLORER.md) | All 40+ query methods — balances, tokens, transactions, markets |
| [Encoder](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/ENCODER.md) | PSBT generation — encoding types, options, pre-flight validation, P2SH two-phase |
| [Batch Builder](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/BATCH.md) | Fluent API for multi-action transactions |
| [Contracts](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/CONTRACTS.md) | VM smart contract integration: deploy, execute, deposit, withdraw |
| [WebSocket](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/WEBSOCKET.md) | Real-time event streaming: blocks, actions, addresses, markets |
| [Wallet & Auth](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/WALLET.md) | Key management, PSBT signing, challenge-response verification |
| [Messaging](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/MESSAGING.md) | ECIES/ECDH/AES encryption for MESSAGE actions |
| [Format Selection](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/FORMAT_SELECTION.md) | How the SDK picks the optimal format version |
| [Errors](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/ERRORS.md) | All error classes, codes, and troubleshooting |
| [Examples](https://github.com/XChain-platform/xchain-documentation/blob/master/components/sdk/EXAMPLES.md) | End-to-end code examples |

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

// Full lifecycle: create, encode, sign, broadcast, wait for indexer
const tx = await sdk.submitAction(
    { action: 'SEND', params: { tick: 'MYTOKEN', amount: '100', destination: 'bc1q...' } },
    { pubkey: '02abc123...' },
    { wif: 'your-wif-key' }
);
console.log(tx.txid);    // transaction hash
console.log(tx.indexed); // action data from the indexer

// Wallet session: bind to a key and send multiple actions
const session = sdk.session('your-wif-key');
await session.send({ tick: 'MYTOKEN', amount: '50', destination: 'bc1q...' });
await session.send({ tick: 'MYTOKEN', amount: '50', destination: 'bc1q...' });
const balances = await session.getBalances();

// Workflow recipes: multi-step operations in one call
await sdk.issueAndDistribute('your-wif-key',
    { tick: 'NEWTOKEN', maxSupply: '1000000', decimals: 8 },
    [
        { destination: 'bc1qaddr1...', amount: '500000' },
        { destination: 'bc1qaddr2...', amount: '300000' }
    ]
);

// Query blockchain data
const token = await sdk.getToken('MYTOKEN');
```

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start JSON-RPC server (port from `SDK_API_PORT`, default 3005) |
| `npm test` | Run unit tests |
| `npm run repl` | Start interactive REPL with a pre-configured SDK instance |
| `npm run build` | Production browser bundle → `dist/xchain_sdk.min.js` |
| `npm run build:dev` | Development browser bundle → `dist/xchain_sdk.js` |

## Test Suite

| Type | Tests |
|---|---|
| Unit — actions, validators, format selection, convenience methods | 300+ |
| Unit — explorer, encoder, retry, WebSocket, wallet, auth, contracts | 150+ |
| Boundary — exact encoding limits | 36 |
| Fuzz — garbage types, unicode, prototype pollution | 56 |
| Chaos — malformed responses, HTTP errors, timeouts | 28 |
| Round-trip — serialize → parse → verify for all 29 actions | 34 |
| Smoke — boot API server, end-to-end JSON-RPC | 11 |
| **Total** | **520+** |

---

**Copyright &copy; 2025 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **Dankest Community License**
(based on the Apache License 2.0 with additional non-commercial and network-disclosure terms).

You may not use, modify, or distribute this material except in compliance with the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
A full copy of the License is also available at: [https://dankest.llc/license](https://dankest.llc/license)
