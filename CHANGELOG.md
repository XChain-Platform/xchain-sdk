# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.0] - 2026-04-23

### Added
- `WalletUtils.decomposePsbt(psbtHex)` — vendor-agnostic PSBT introspection for hardware-signer format converters. Returns a normalized `{ txVersion, locktime, network, inputs[], outputs[] }` shape with per-input `prevTxHash`, `prevTxIndex`, `sequence`, `value`, `scriptPubKeyHex`, `scriptType` (`'p2wpkh' | 'p2wsh' | 'p2pkh' | 'p2sh-p2wpkh' | 'p2sh-p2wsh' | 'p2sh' | 'p2tr' | 'unknown'`), `sighashType`, `nonWitnessUtxoHex`, `witnessUtxoScriptHex`, `redeemScriptHex`, `witnessScriptHex`, `address`, and `prevTxInfo` (a parsed Trezor-`refTxs`-shaped object populated when `nonWitnessUtxo` is present, so wallets can build Trezor `refTxs` / Ledger prev-tx args without bitcoinjs-lib themselves). BIP32 derivation info is deliberately omitted — the wallet tracks signing paths on its own Address records and pairs them with inputs by index via the `signingPaths` argument passed to each signer's `signPsbt`.
- `WalletUtils.txidOf(txHex)` — compute the display-order txid of a signed raw transaction. Used by the hardware-signer path, which receives a `serializedTx` from the device and still needs a txid for broadcast wiring. Handles both legacy and segwit serializations (bitcoinjs-lib's `Transaction.fromHex` auto-detects the marker and `getId()` hashes over the non-witness portion correctly).
- Internal `classifyScript(scriptBuf, redeemScriptBuf?)` helper that inspects raw opcode bytes (rather than round-tripping through `bitcoin.payments`) so nested-segwit disambiguation (`p2sh-p2wpkh` vs bare `p2sh`) stays local to the classifier.
- Internal `serializePrevTx(tx)` helper that converts a bitcoinjs-lib `Transaction` into Trezor Connect's `RefTransaction` shape — `hash` as display-order txid, `bin_outputs[].amount` as decimal strings, `inputs[]` with `prev_hash` / `prev_index` / `script_sig` / `sequence`.
- `XChainSDK.decomposePsbt(psbtHex)` + `XChainSDK.txidOf(txHex)` convenience passthroughs.
- 7 new tests in `test/unit/wallet.test.js` under `decomposePsbt()`: argument validation, P2WPKH on bitcoin-regtest (with `bcrt1q` address round-trip), P2PKH on dogecoin-regtest (nonWitnessUtxo lane, with `prevTxInfo` assertions), P2SH-P2WPKH nested-segwit classification, multi-input/multi-output litecoin-regtest, and version/locktime/sequence exposure.

### Developer notes
- `decomposePsbt` + `txidOf` are net-new — pre-existing `signPsbt` behavior, input-validation error codes, and return shape are unchanged. Minor-version bump because the public surface area grows.
- The hardware-signer integration landing in `xchain-wallet` consumes these methods through the existing `SDKRegistry` DI pattern: `TrezorSigner.signPsbt` / `LedgerSigner.signPsbt` call `sdk.wallet.decomposePsbt` on the active chain's SDK instance, translate the normalized shape to the vendor's envelope via per-vendor pure converters in `@xchain-wallet/core`, and route the device's returned `serializedTx` through `sdk.wallet.txidOf` for the broadcast step. Keeps `bitcoinjs-lib` out of the wallet's `@xchain-wallet/core` dependency graph (see `xchain-wallet/packages/core/src/sdk/SDKRegistry.js` for the rationale).
- Full SDK unit test count is now 531 passing (+7 decomposePsbt cases). The 5 pre-existing unrelated failures (`Actions`, `Convenience`, `ExplorerClient`, `Round-trip`, `Validator — ENCRYPTION_METHOD`) are untouched.

## [1.8.1] - 2026-04-23

### Fixed
- `Validator._validateDispenser` — coin-paid dispenser creates (the primary `DISPENSER.md` §40.7.1 lane, where the buyer pays in the native coin and `GET_TICK` is empty) were incorrectly rejected with `MISSING_REQUIRED_FIELD: GET_TICK`. Required-fields set narrowed to `['GIVE_TICK', 'GIVE_AMOUNT', 'GET_AMOUNT']`; a new cross-field check requires either `GET_TICK` (token-paid) or `GET_COIN` (coin-paid) to be set. Matches the protocol example `DISPENSER|0|BTC|JDOG|1|10|BTC||0.01|...` and unblocks `xchain-wallet`'s DispenserForm authoring surface.

### Added
- 4 new tests in `test/unit/validator.test.js` under `Validator — DISPENSER create required fields`: coin-paid accept, token-paid accept, reject when neither GET_TICK nor GET_COIN is set, and verification that GIVE_TICK / GIVE_AMOUNT / GET_AMOUNT remain required.

## [1.8.0] - 2026-04-07

### Added
- **Staking actions**: STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION, CLAIM_REWARDS — format definitions, validation (TIER, SIGNING_PUBKEY, CHAINS), convenience methods, round-trip tests (BTC-only)
- **Transaction Lifecycle Manager** (`sdk.submitAction()`): full encode → sign → broadcast → wait pipeline in a single call, with automatic P2SH two-phase handling and progress callbacks
- **Wallet Session** (`sdk.session(wif)`): bound wallet object that bundles address/key/UTXO state with action convenience methods — eliminates passing WIF/pubkey into every call
- **Fee Estimation** (`sdk.estimateFees()`): dry-run fee calculation via encoder, returns fee in satoshis plus reusable PSBT to avoid double-encoding
- **UTXO Cache** (`UTXOCache`): in-memory UTXO tracker with speculative change outputs, prevents double-spend on rapid sequential transactions from the same address
- **Event-Driven Confirmation** (`sdk.waitForAction(txid)`): WebSocket + polling hybrid that resolves when the indexer processes a transaction, with configurable timeout and validity checks
- **Workflow Recipes** (`sdk.workflows`): high-level multi-step helpers — `issueAndDistribute`, `issueAndMint`, `createDispenser`, `createOrder`, `cancelOrder`, `stakeAndDelegate`, `deployAndFund`, `distributeDividend`
- **Cross-Chain Helper** (`CrossChainHelper`): coordinate actions across multiple SDK instances — `createSwap`, `link`, `parallel`, `waitForAll`, `getAllBalances`
- **Interactive REPL** (`npm run repl`): drops into a Node.js REPL with pre-configured SDK, custom `.actions`, `.status`, `.fields` commands
- **SDKActionError** error class for lifecycle failures (confirmation timeout, action rejected by indexer)
- Enriched encoder error context: `details.context` now carries structured indexer rejection data from `body.error.data`
- 5 new round-trip tests for staking actions (520 total passing)
- TypeScript definitions for all new types, classes, and methods
- New exports: `WalletSession`, `CrossChainHelper`, `UTXOCache`, `startREPL`, `SDKActionError`, `SDKMessagingError`

## [1.7.0] - 2026-04-07

### Added
- Cross-chain messaging: `COIN` field (BTC, LTC, DOGE) in all MESSAGE formats enables sending messages to any address on any chain
- `getAllMessages()` in `MessagingUtils` — queries multiple explorers in parallel and merges results
- `getAllMessagesForAddress()` convenience method on `XChainSDK` — automatically queries all chains (BTC, LTC, DOGE) on the configured network tier
- `COIN` field validation in `Validator` (must be BTC, LTC, or DOGE)
- `coin` and `chain` fields on message objects returned by `getMessages()` / `getAllMessages()`

### Changed
- MESSAGE format strings updated to `VERSION|COIN|DESTINATION|...`
- `send()` in `MessagingUtils` now requires `coin` parameter
- `COIN` added to MESSAGE required fields in validator

## [1.6.0] - 2026-04-07

### Added
- `src/messaging.js` — `MessagingUtils` class: ECIES encrypt/decrypt (ephemeral keypair per message, AES-256-GCM), ECDH session key exchange and shared secret derivation, AES pre-shared key encrypt/decrypt, public key lookup via explorer, high-level `send()` and `getMessages()` with automatic encryption and decryption
- `SDKMessagingError` error class in `src/errors.js`
- `getPublicKey()` method on `ExplorerClient` for address-to-pubkey resolution
- `sdk.messaging` sub-object on `XChainSDK` with 3 top-level convenience methods: `sendMessage()`, `getPublicKey()`, `getMessagesForAddress()`

### Changed
- `src/validator.js` — `ENCRYPTION_METHOD` validation updated to accept `[1, 2, 3]` (1=ECIES, 2=ECDH, 3=AES)

## [1.5.0] - 2026-04-07

### Added
- `src/networks.js` — network parameter registry for all 9 supported BTC/LTC/DOGE networks (ported from xchain-encoder CryptoNetworks)
- `src/auth.js` — `AuthUtils` class: challenge-response wallet ownership verification (`generateChallenge`, `signMessage`, `verifyOwnership`, `verifyMessage`), supports custom messages for SDK-independent verification
- `src/wallet.js` — `WalletUtils` class: key management (`importWIF`, `generateKeyPair`), address derivation (`deriveAddress` with P2PKH/P2WPKH/P2SH-P2WPKH), address validation (`validateAddress`), PSBT signing (`signPsbt`), transaction broadcasting (`broadcastTx`), UTXO queries (`getUTXOs`)
- `SDKWalletError` and `SDKAuthError` error classes in `src/errors.js`
- `broadcastTx()` and `getUTXOs()` RPC methods on `EncoderClient` in `src/encoder.js`
- `sdk.wallet` and `sdk.auth` sub-objects on `XChainSDK` with 11 top-level convenience pass-throughs
- `WalletUtils`, `AuthUtils`, `SDKWalletError`, `SDKAuthError` exported from `index.js`
- TypeScript definitions for all new types, interfaces, and class methods in `index.d.ts`
- New runtime dependencies: `bitcoinjs-lib`, `bitcoinjs-message`, `ecpair`, `@bitcoinerlab/secp256k1`
- Unit tests: `test/unit/networks.test.js`, `test/unit/auth.test.js`, `test/unit/wallet.test.js` (69 new tests, 520 total passing)

## [1.4.3] - 2026-04-06

### Changed
- Move coverage badge to its own line in README.md for cleaner formatting

## [1.4.2] - 2026-04-05

### Changed
- Reorganized flat `test/` directory into subdirectories by test type: `unit/`, `smoke/`, `integration/`, `boundary/`, `fuzz/`, `chaos/`
- Added dedicated npm scripts: `test:smoke`, `test:integration`, `test:boundary`, `test:fuzz`, `test:chaos`, `test:all`
- Default `npm test` now runs only unit tests with a 5s timeout (previously ran all tests with no timeout)

## [1.4.1] - 2026-04-05

### Fixed
- Fix broken documentation links in README — point to correct `components/sdk/` path in xchain-documentation

## [1.4.0] - 2026-04-03

### Added
- Real-time WebSocket client module (`src/websocket.js`) for streaming events from xchain-explorer
- WebSocket connection management: connect, disconnect, isConnected, automatic reconnection with exponential backoff
- Subscribe/unsubscribe with Promise-based request-response correlation via request IDs
- Event dispatch system: on, off, once handlers with wildcard support
- Automatic catch-up on reconnect via `since_action_index`
- WebSocket lifecycle hooks: onWsConnect, onWsDisconnect, onWsMessage, onWsReconnect
- Convenience methods on XChainSDK: onBlock, onAction, onAddress, onToken, onMarket, onDispenser, onCoinpayRequired, onOrderMatch, onNetworkStats
- All convenience methods return unsubscribe functions for clean teardown
- `connectWs()` and `disconnectWs()` methods on XChainSDK
- `websocketUrl` and `websocketPort` constructor options (falls back to explorerUrl/explorerPort)
- WebSocket client auto-initialized when explorer URL is configured
- `sdk.stop()` automatically disconnects WebSocket
- 36 new tests: WebSocket client (19) and convenience methods (17) using in-process mock server

## [1.3.0] - 2026-04-03

### Added
- VM smart contract support: DEPLOY, EXECUTE, DEPOSIT, WITHDRAW actions with full format definitions, validation, and convenience methods
- Rest-field (`...PARAMS`) support in FormatSelector for variable-length pipe-delimited parameters (EXECUTE params, DEPLOY constructor params)
- DEPLOY auto hex-encodes raw `code` parameter into CODE_ENCODING field
- `SDKContractError` error class for contract-specific errors
- `ContractUtils` module (`sdk.contracts`): hex encode/decode, syntax validation (acorn), float detection, code size checks, gas estimation
- `ContractClient` module (`sdk.contract(actionIndex)`): bound client with `call()`, `deposit()`, `withdraw()`, and explorer query methods
- 8 explorer contract query methods: getContract, getContracts, getContractState, getContractBalance, getExecution, getExecutions, getDeposits, getWithdrawals
- BatchBuilder support for EXECUTE, DEPOSIT, WITHDRAW (DEPLOY excluded from BATCH)
- TypeScript definitions for all new interfaces, classes, and methods
- 106 new tests across 14 test sections in `test/vm.test.js` (657 total)

### Changed
- Action count updated from 20 to 24 across tests
- Explorer public method count updated from 40 to 48
- Validator updated to reject DEPLOY in BATCH actions

## [1.2.0] - 2026-04-02

### Added
- COINPAY action: format definition, validation, and `sdk.coinpay()` convenience method for native coin DEX payment settlement
- COINPAY round-trip test

### Changed
- ORDER validation: allow null/empty GIVE_TICK or GET_TICK for native coin pairs (at least one TICK still required)
- Action count updated from 19 to 20 across tests

## [1.1.1] - 2026-03-31

### Changed

- Center badge layout in README
- Replace blockchain-specific references with "XChain Platform" in README description
- Update documentation links to point to full GitHub URLs for xchain-documentation repo

## [1.1.0] - 2026-03-31

### Added

- **Core Action Engine** — `createAction()` pipeline: normalize input, validate fields, select optimal format version, serialize to pipe-delimited ACTION string
- **Format Selector** — automatically picks the smallest format version that fits the provided fields (e.g., ISSUE v1 for description-only updates vs v0 for full creates)
- **Validator** — per-action input validation for all 19 ACTION types: TICK name rules, character restrictions, numeric bounds, lock values, FIAT codes, BATCH constraints, required field enforcement
- **Pre-flight Encoding Validation** — catches impossible encoding choices (e.g., OP_RETURN with oversized data, MULTISIGN without compressedPubKey) before calling the encoder
- **Explorer Client** — HTTP client wrapping all 40 xchain-explorer REST API endpoints with automatic coin prefix derivation from network string, pagination support, and typed errors
- **Encoder Client** — JSON-RPC client wrapping xchain-encoder's `create_tx` method with full parameter support, plus `spendP2sh()` helper for P2SH/P2WSH two-phase transactions
- **Hub Connector** — xchain-hub integration for automatic service discovery via `getallconfigs`, with configurable polling interval and config change detection
- **Config Resolution Chain** — constructor options > hub-discovered > environment variables > defaults
- **JSON-RPC API Server** — 52 methods exposing all SDK functionality over HTTP (run via `npm run api`)
- **Convenience Action Methods** — `sdk.send()`, `sdk.issue()`, `sdk.mint()`, and 16 more shorthand methods for all ACTION types, plus `sdk.transfer()` as an alias for `sdk.send()`
- **Batch Builder** — fluent API for composing BATCH actions: `sdk.batch().send({...}).mint({...}).build()` with automatic BATCH constraint enforcement and sub-action validation
- **Retry with Exponential Backoff** — configurable retry logic for transient network errors (HTTP 429, 502, 503, 504, timeouts, connection resets) with jitter and Retry-After header support
- **Request Hooks** — optional `onRequest`, `onResponse`, `onError`, `onRetry` callbacks for monitoring all network calls to explorer and encoder
- **Connection Pooling** — configurable HTTP agent options (maxSockets, keepAlive, keepAliveMsecs, maxFreeSockets) for explorer and encoder clients
- **Error Class Hierarchy** — 7 typed error classes (SDKError, SDKValidationError, SDKFormatError, SDKEncoderError, SDKExplorerError, SDKHubError, SDKConfigError) with machine-readable codes and contextual details
- **Introspection Helpers** — `getActions()`, `getActionFormats()`, `getActionFields()`, `validateAction()` for programmatic discovery of supported actions and their parameters
- **Module Entry Point** — `index.js` exporting XChainSDK, BatchBuilder, and all error classes for library use via `require('xchain-sdk')`
- **TypeScript Definitions** — `index.d.ts` with full type coverage for IDE autocomplete and type checking
- **Browser Bundle** — Browserify + Babel build pipeline: `npm run build` (minified) and `npm run build:dev` (development)
- **Test Suite** — 551 tests across 12 test files: unit, boundary, fuzz, chaos, round-trip, and smoke tests
