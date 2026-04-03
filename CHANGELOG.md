# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
