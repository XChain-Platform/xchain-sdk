<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright © 2025-2026 Dankest, LLC -->

# XChain Platform - Software Developer Kit (SDK)

<p align="center">
  <img src="https://img.shields.io/npm/v/%40dankest-llc%2Fxchain-sdk" alt="npm version">
  <img src="https://img.shields.io/badge/tests-4%2C345%2B%20passing-brightgreen" alt="Tests">
  <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node">
  <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/coverage-unit%20%7C%20integration%20%7C%20boundary%20%7C%20fuzz%20%7C%20chaos%20%7C%20smoke%20%7C%20security%20%7C%20regression%20%7C%20performance-brightgreen" alt="Coverage">
</p>

Developer-facing SDK for the [XChain Platform](https://xchain.io/): generate XChain transactions and query blockchain data.

## Features

- **31 ACTION types**: `sdk.send()`, `sdk.issue()`, `sdk.mint()`, `sdk.stake()`, and 27 more convenience methods
- **Transaction lifecycle**: `sdk.submitAction()` handles the full encode -> sign -> broadcast -> wait pipeline in one call
- **Wallet sessions**: `sdk.session(wif)` bundles address/key/UTXO state for repeated actions from one address
- **Fee estimation**: `sdk.estimateFees()` returns fee info without signing or broadcasting
- **UTXO chaining**: in-memory UTXO cache prevents double-spend on rapid sequential transactions
- **Workflow recipes**: `sdk.issueAndDistribute()`, `sdk.deployAndFund()`, `sdk.stakeAndDelegate()`, and more
- **Cross-chain helpers**: coordinate swaps and parallel actions across BTC, LTC, and DOGE SDK instances
- **Event-driven confirmation**: `sdk.waitForAction(txid)` resolves when the indexer processes a transaction
- **Contract settle gate**: `sdk.waitForContractState(index, { key: 'status', equals: 'FUNDED' })` and `sdk.waitForContractBalance(index, tick, { minQuantity })` wait on the contract's own state, which is the only signal that cannot race the indexer; `submitAction({ awaitContract: {...} })` runs the same gate inline, so a deposit does not hand control back before the contract has been credited
- **Interactive REPL**: `npm run repl` drops into a live session with a pre-configured SDK instance
- **Automatic format selection**: picks the smallest encoding format for every action
- **PSBT generation**: integrates with xchain-encoder to produce unsigned transactions
- **115+ explorer query methods**: balances, tokens, transactions, markets, history, contracts
- **Batch builder**: fluent API: `await sdk.batch().send({...}).mint({...}).build()` (`build()` is async)
- **Real-time events**: WebSocket streaming with `onBlock()`, `onAction()`, `onAddress()`, and more
- **Encrypted messaging**: ECIES, ECDH, and AES encryption for MESSAGE actions; `messaging.send()` accepts a `Buffer` payload and `getMessages()` exposes `msg.bytes` for binary ECIES
- **Token-gated file publishing**: `sdk.gatedFile.encryptFileBytes()` and `sdk.gatedFile.encryptPack()` produce AES-256-GCM ciphertext + key for FILE v1 gated content; key handoff as a compact 33-byte binary payload via `serializeKeyPayload()` / `parseKeyPayload()` (sent through ECIES in binary mode). See [Token-Gated Content](https://docs.xchain.io/protocol/token-gated-content)
- **Attestation envelope helpers**: `AttestationHelpers.llm({...})` builds the JSON envelope a VM contract passes to `xchain.attestation.request(...)` with provider_id `'llm'`; `AttestationHelpers.httpGet({url})` validates the URL and returns the payload string for `'http_get'`; `AttestationHelpers.requestOptions({redundancy, deadlineBlocks})` builds the gateway options object. By design these are envelope builders only: there is no user-submittable ATTEST action. ATTEST v0 (request) and v1 (response) are VM-emitted: a contract calls `xchain.attestation.request(...)` and validators emit the on-chain attestation. So the SDK helps you shape the request a contract makes, and you read the results via `getAttestations()`. It does not (and cannot) encode an ATTEST action directly, the same way XCALL is VM-emission-only.
- **Token-ownership trading helpers**: `ORDER`/`SWAP`/`DISPENSER` v0 carry `GIVE_OWNERSHIP` / `GET_OWNERSHIP` flags; `SWEEP` carries independent `ORDERS` / `SWAPS` / `DISPENSERS` flags (was a single `ESCROWS` flag)
- **HTTP 402 payments**: `X402Client` and `X402Gateway` implement an XChain-native, x402-shaped pay-per-call flow over on-chain SEND actions, with `xchain-send` (pay-per-call), `xchain-dispenser` (hold-to-access), and `xchain-deposit` (metered spend ledger) schemes; fail-closed by default on `maxAmount`. See [x402 Payments](https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/x402-payments.md)
- **Contract-targeted staking**: `session.stakeToContract({ amount, signingPubkey, targetContractIndex, tick })`, `session.unstakeFromContract({...})`, and `session.delegateForContract({...})` emit STAKE v3 / UNSTAKE v1 / DELEGATE v1 against a smart contract deployed via DEPLOY v1 (with `COOLDOWN_BLOCKS` + `SLASH_DESTINATION`). High-level recipes: `sdk.deployStakeableContract()` and `sdk.stakeToContractAndDelegate()`
- **NFT helpers**: `sdk.nft.unique()`, `sdk.nft.edition()`, `sdk.nft.collectionItem()`, `sdk.nft.attachContentParams()`, and `sdk.nft.isNft()` for building the NFT pattern (ISSUE with DECIMALS=0 + LOCK_MAX_SUPPLY=1) plus high-level `sdk.issueNft()`, `sdk.issueNftEdition()`, `sdk.issueCollectionItem()`, and `sdk.attachContent()` submit recipes
- **Project registry helpers**: `sdk.project.rosterParams()` and `sdk.project.rosterEditParams()` build LIST actions for owner-attested token rosters; `sdk.setRoster()` runs LIST then LINK and waits for the indexer
- **Ticker compaction**: on by default; resolves token tickers to their compact `^id` wire form via the explorer before encoding to shrink on-chain payload size; opt out with `{ compactTickers: false }`
- **MCP server**: `npx xchain-mcp` exposes all explorer query tools as Model Context Protocol tools for AI agent use
- **Wallet & auth**: key management, PSBT signing, challenge-response verification
- **Smart contracts**: deploy, execute, deposit, withdraw via xchain-vm integration
- **Hub discovery**: auto-resolves service endpoints from xchain-hub
- **Retry with backoff**: handles HTTP 429/502/503/504, respects `Retry-After` headers
- **Request hooks**: `onRequest`, `onResponse`, `onError`, `onRetry` callbacks
- **TypeScript definitions**: full `.d.ts` for IDE autocomplete
- **Browser bundle**: Browserify build for client-side use

## Documentation

Full SDK developer guide is published at [docs.xchain.io/components/sdk](https://docs.xchain.io/components/sdk/):

| Document | Description |
|---|---|
| [README](https://docs.xchain.io/components/sdk/) | Overview, installation, usage modes |
| [Configuration](https://docs.xchain.io/components/sdk/configuration) | Constructor options, env vars, hub discovery, retry, pooling, hooks |
| [Actions](https://docs.xchain.io/components/sdk/actions) | All 31 ACTION types: params, validation rules, format versions, examples |
| [Transaction Lifecycle](https://docs.xchain.io/components/sdk/lifecycle) | submitAction, fee estimation, UTXO chaining, P2SH two-phase handling |
| [Wallet Sessions](https://docs.xchain.io/components/sdk/sessions) | Bound wallet sessions, convenience methods, UTXO cache |
| [Workflows](https://docs.xchain.io/components/sdk/workflows) | High-level recipes: issueAndDistribute, deployAndFund, stakeAndDelegate |
| [Cross-Chain](https://docs.xchain.io/components/sdk/crosschain) | Multi-chain coordination: parallel actions, swaps, links |
| [Explorer](https://docs.xchain.io/components/sdk/explorer) | All 115+ query methods: balances, tokens, transactions, markets |
| [Encoder](https://docs.xchain.io/components/sdk/encoder) | PSBT generation: encoding types, options, pre-flight validation, P2SH two-phase |
| [Batch Builder](https://docs.xchain.io/components/sdk/batch) | Fluent API for multi-action transactions |
| [Contracts](https://docs.xchain.io/components/sdk/contracts) | VM smart contract integration: deploy, execute, deposit, withdraw |
| [WebSocket](https://docs.xchain.io/components/sdk/websocket) | Real-time event streaming: blocks, actions, addresses, markets |
| [Wallet & Auth](https://docs.xchain.io/components/sdk/wallet) | Key management, PSBT signing, challenge-response verification |
| [Messaging](https://docs.xchain.io/components/sdk/messaging) | ECIES/ECDH/AES encryption for MESSAGE actions |
| [Light Client (SPV)](https://docs.xchain.io/components/sdk/light-client) | Cryptographic balance/action verification against stake-weighted checkpoints |
| [NFT & Registry Builders](https://docs.xchain.io/components/sdk/nft-and-registry) | NFT pattern builders, collection/content attachment, project roster LIST/LINK |
| [Format Selection](https://docs.xchain.io/components/sdk/format-selection) | How the SDK picks the optimal format version |
| [Errors](https://docs.xchain.io/components/sdk/errors) | All error classes, codes, and troubleshooting |
| [Examples](https://docs.xchain.io/components/sdk/examples) | End-to-end code examples |

## Install

```bash
npm install @dankest-llc/xchain-sdk
```

Node 22 or newer. For development against the source, clone this repository and `npm install` inside it; the companion MCP server for AI agents is published separately as [`xchain-mcp`](https://www.npmjs.com/package/xchain-mcp).

## Quick Start

```js
const { XChainSDK } = require('@dankest-llc/xchain-sdk');

// Zero-config: a network alone targets the public XChain Platform.
// Mainnet/testnet default to the public hosts (hub.xchain.io discovers
// explorer/encoder, falling back to explorer.xchain.io / encoder.xchain.io);
// any *-regtest network defaults to localhost.
const sdk = new XChainSDK({ network: 'bitcoin-mainnet' });

// To point at your own services, pass full URLs (include the scheme; a
// bare host is treated as http://host:<dev-port>):
// const sdk = new XChainSDK({
//     network: 'bitcoin-mainnet',
//     explorerUrl: 'https://explorer.example.com',
//     encoderUrl:  'https://encoder.example.com'
// });

// Generate an action string
const result = await sdk.send({
    tick: 'MYTOKEN',
    amount: '100',
    destination: 'bc1q...',
    memo: 'Payment'
});
console.log(result.actionString); // 'SEND|0|MYTOKEN|100|bc1q...|Payment'

// Multi-destination SEND: one entry per recipient. The wire format version
// is chosen from the legs (v1 shared tick, v2 per-leg tick, v3 per-leg memo).
// A flat {tick, amount, destination} map can only ever express ONE leg, so
// the SDK refuses one against a multi-leg format instead of repeating leg 1.
const multi = await sdk.send({
    tick: 'MYTOKEN',
    legs: [
        { amount: '100', destination: 'bc1qaddr1...' },
        { amount: '250', destination: 'bc1qaddr2...' }
    ]
});
console.log(multi.actionString); // 'SEND|1|MYTOKEN|100|bc1qaddr1...|250|bc1qaddr2...'

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

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `NETWORK` | Yes | (none) | Default coin and network (e.g. `bitcoin-regtest`, `dogecoin-mainnet`) |
| `SDK_API_PORT` | No | `3005` | Port for the optional SDK helper API |
| `SDK_API_KEY` | No | (none) | API key for the helper API; required as `Authorization: Bearer <key>` on every method except `ping` (methods reject with 401 when unset) |
| `CORS_ORIGIN` | No | Disabled | CORS allowed origin for the helper API |
| `EXPLORER_URL` / `EXPLORER_PORT` | No | `127.0.0.1` / `8080` | xchain-explorer location |
| `ENCODER_URL` / `ENCODER_PORT` | No | `127.0.0.1` / `3003` | xchain-encoder location |
| `HUB_URL` | No | (none) | Full xchain-hub URL |
| `HUB_API_HOST` / `HUB_PORT` | No | (none) | xchain-hub host/port form used by some SDK paths |
| `HUB_API_KEY` | No | (none) | API key for `getallconfigs` against keyed hubs; public zero-config discovery should use the hub's chain-registry endpoint instead |
| `WEBSOCKET_URL` / `WEBSOCKET_PORT` | No | `127.0.0.1` / `3007` | Explorer WebSocket endpoint for live updates |

## Scripts

| Command | Description |
|---|---|
| `npm run api` | Start JSON-RPC server (port from `SDK_API_PORT`, default 3005) |
| `npm test` | Run unit tests (4,051 tests) |
| `npm run repl` | Start interactive REPL with a pre-configured SDK instance |
| `npm run build` | Production browser bundle -> `dist/xchain_sdk.min.js` |
| `npm run build:dev` | Development browser bundle -> `dist/xchain_sdk.js` |

## Test Suite

| Type | Tests |
|---|---|
| Unit: actions, validators, format selection, convenience methods, explorer, encoder, retry, WebSocket, wallet, auth, contracts, co-signer | 3206+ |
| Integration: cross-module flows, VM/contract integration, hub discovery | 98+ |
| Security: input attack surface, auth gates | 18+ |
| Regression: curated critical-path suite, including round-trip serialize -> parse -> verify | 23+ |
| Boundary: exact encoding limits | 35+ |
| Fuzz: garbage types, unicode, prototype pollution | 65+ |
| Chaos: malformed responses, HTTP errors, timeouts | 27+ |
| Smoke: boot API server, end-to-end JSON-RPC | 9+ |
| Performance | 3 |
| **Total** | **3484+** |

---

**Copyright &copy; 2025-2026 Dankest, LLC**

**Based on XChain Platform by Dankest, LLC &ndash; https://dankest.llc**

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-or-later)
with a commercial license available for proprietary use.

You may use, modify, and distribute this material under the terms of the License.
See [LICENSE](./LICENSE.md) and [NOTICE](./NOTICE.md) for full terms.
See the [licensing overview](https://docs.xchain.io/legal/licensing).
