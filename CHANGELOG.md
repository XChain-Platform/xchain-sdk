# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `npm run release:npm-check` fails while the npm registry serves a version other than the repo's, for the SDK and the MCP server.
- `verifyLockedBalance` gives consumers a locked-balance network path that binds the served proof to the quorum-signed checkpoint, mirroring `verifyBalance`.

### Changed
- `verifyBalance` now passes the requested identity through the verifier's `expected` binding, so a proof echoing a different address or tick is refused as `REQUESTED_IDENTITY_MISMATCH`.
- `verifyLockedBalanceProof` gates escrow-leaf arming on a caller-supplied trusted height instead of the server-authored `proof.height`, and refuses a proof relabelled off it as `PROOF_HEIGHT_MISMATCH`.

### Deprecated
- Calling `verifyBalanceProof`, `verifyLockedBalanceProof` or `verifyContractStateProof` without the `expected` identity argument; it becomes required at the next major version.
- Calling `verifyLockedBalanceProof` without a `trustedHeight`; meanwhile it gates at height 0, which refuses every chain armed mid-chain, and it becomes required at the next major version.

## [0.10.0] - 2026-08-13

Renumbered from an unpublished in-repo 2.0.3 cut before first publish: the SDK joins the platform version stream at this release, and the 2.x versions on npm are deprecated in its favor.

### Added
- `buildLlmEnvelope` rejects a temperature outside [0, 2] instead of deferring the failure to the hub.
- Pre-flight warns on a non-canonical `^<id>` address reference and marks a well-formed one unverified.
- `npm run ci` now runs the pre-flight drift gate, which still skips clean without a sibling indexer checkout.
- `verifyBalanceProof`, `verifyLockedBalanceProof` and `verifyContractStateProof` take an optional expected identity and refuse a valid proof that answers a different key.
- Taproot envelopes work on 2-of-3 co-signer accounts, so a commit output keeps its two-of-three property.
- `CoSignerClient` accepts `recoveryPublicKey` and derives the 2-of-3 tap tree itself, cross-checking any supplied `tweaks`.

### Changed
- **BREAKING** `AgentSession` now requires a spend ceiling and a stable `submitOpts.idempotencyKey`, and adds an operator kill switch; `allowUnbounded` / `allowUnkeyedSubmits` opt back out.
- **BREAKING** `X402Client` is fail-closed on spend: omitting `maxAmount` applies a default per-payment ceiling, and unbounded spending is an explicit opt-in.
- **BREAKING** `X402Client.fetchUrl` no longer double-pays on retry; it throws `X402_PAYMENT_AMBIGUOUS` with a resume handle instead.

### Fixed
- `CORS_ORIGIN` is a comma-separated allowlist rather than an echo of every request origin.
- An envelope reveal signs the leaf's untweaked aggregate explicitly, fixing a wrong-key signature on tweaked accounts.
- BigInt satoshi values serialize as quoted decimal strings, matching what the encoder parses.
- `buildRecoverySpend` reconciles inputs and outputs in exact u64, so an account above 2^53 satoshi cannot defeat its anti-burn guard.
- `reconcileEncoded` parses the caller's `maxFeeSats` cap in exact u64, so a cap above 2^53 no longer false-denies an honest fee.
- Explicit action versions run the serializer no-data-loss check instead of bypassing it.
- Structurally corrupt velocity-window rows fail closed on load rather than reopening spend limits.
- Stake-weighted quorum rejects a validator entry with a missing or non-numeric weight instead of lowering the denominator.
- Hardware-signing decomposition handles values above 2^53 without rounding.
- `FEE_CHARGING_ACTIONS` includes BET, restoring its `NATIVE_FEE_FORFEIT` warning.
- The WebSocket ticks subscription filter no longer silently no-ops on the actions channel.
- `getContracts` and both `getExecutions` declarations return a list envelope, matching what Explorer emits.
- The pre-flight drift gate covers fee classification and VM gas inputs.
- Corrected a protocol-constants header that described a cross-repo tripwire which does not exist.
- `Utility.withForcedVersion` strips every spelling of the version and throws on a mismatch, closing a silent misroute of staked assets.
- Weighted checkpoint verification requires a valid weight and non-blank source on every validator entry.
- A checkpoint missing its commitment roots after activation is rejected rather than verified against the legacy preimage.
- Co-signer output caps compare as exact u64, so an output one satoshi above a cap larger than 2^53 is no longer approved.
- Review-round hardening: sub-root slot pinning in `verifyBalanceProof`, opt-in submit idempotency, fail-closed co-signer sidecar auth, compiled-push OP_RETURN pre-flight, network-aware oversize suggestions, an attestation SSRF gate, and derivation tests.

### Security
- MuSig2 key aggregation rejects a repeated participant key, which previously collapsed the policy threshold to one signer.
- `verifyAnchoredCheckpoint` requires the committed roots to sit inside the signed canonical, closing an attacker-chosen SPV root bypass.
- `submitAction` reconciles every encoder-authored PSBT against the submitted intent before signing, blocking fund redirection and fee burn.
- `generateNonce` refuses to reuse a `sessionId` under different signing inputs, which previously disclosed the private key.
- `CoSigner`, `CoSignerClient` and `MuSig2AgentSession` require exactly the two-key pair they can sign for, so no unspendable aggregate address can be funded.

### Removed
- The `statuses` WebSocket filter is gone from `onAction`, `onAddress` and `onOrderMatch`, because no explorer channel populated it.

### Added
- Armed the three BTC-anchored activation copies (checkpoint commitment, EQUIV header, stake-weighted quorum) at BTC 961000, in lockstep with the indexer and hub twins.
- `ContractUtils.parseAbi(source)` reads the optional contract `abi` display-metadata block and fails closed on bad input.
- Escrow, vesting and crowdsale templates declare `abi` blocks with method summaries and `view` flags.
- The hub connector takes a `hubApiKey` option (env fallback `HUB_API_KEY`) for `getallconfigs` against keyed hubs.

### Changed
- Re-vendored `lint-core.js` and `metering.js` byte-identical to the canonical xchain-vm copies.
- Re-embedded the crowdsale template via `sync:templates`, picking up the xchain-contracts `saleDecimals` validation.
- Address-ref compaction is action-aware via `SDK_COMPACTABLE_BY_ACTION`, so a field can be compacted for one action and emitted in full for another.

### Fixed
- Delegated dispenser opens serialize the full `GET_ADDRESS` instead of its `^<id>` reference form, so the dispenser is keyed on the real operating address and actually dispenses.

### Security
- `CoSigner` rejects any BIP341 `sighashType` other than `SIGHASH_DEFAULT` and `SIGHASH_ALL`, closing a drain-transaction bypass of the output gate.

## [2.0.2] - 2026-08-02

### Fixed
- Browser and mobile bundles no longer reach for a Node filesystem, so the regtest node sidecar is skipped when absent instead of throwing.
- Taproot envelope reveals complete the commit/reveal pair rather than stranding the commit, and a failed reveal carries its recovery record out.

## [2.0.1] - 2026-08-01

### Changed
- README updated for the npm registry release: install section, `@dankest-llc/xchain-sdk` imports, and an npm version badge.

## [1.14.1] - 2026-07-16

### Fixed
- Light-client checkpoint verification re-applies the source-deduped stake-weighted quorum, restoring the blank-source fail-closed guard.
- Encoder and hub connector port defaults corrected to the servers' real binds (3003 and 10000).
- The co-signer wildcard per-tick window cap now binds when the action carries no tick.

## [1.14.0] - 2026-06-20

### Fixed
- The `onX()` subscription helpers subscribe detached and warn, so an unconfirmed subscription no longer terminates the host process.
- `verifyCheckpoint` applies the stake-weighted quorum predicate when weighting is active and fails closed when no weight or source is supplied.
- Corrected the Litecoin `dustThreshold` from 546 to 5460 litoshis on all three Litecoin networks.
- Encrypted `messaging.send()` no longer throws `NO_MATCHING_FORMAT`, and `getMessages()` infers ECIES when an encrypted body carries no method field.

### Security
- The optional SDK helper API requires `Authorization: Bearer <SDK_API_KEY>` on every method except `ping` and defaults CORS to `origin: false`.

### Changed
- Pinned `bitcoinjs-lib` 6.1.7 and `ecpair` 2.1.0 to exact versions and marked the package private at the time.
- Pinned `mathjs` to exact version 15.2.0 so bignumber arithmetic is identical across services.
- Bumped the `nock` devDependency to `^14.0.0` to align the test toolchain.
- Documented the `getStatus()` response fields `decoder_tip` and `decoder_lag_blocks`.
- Documented that `callbackParams` elements always reach contract callbacks as strings.
- `suggestGasLimit()` counts C-style `for` loops an extra time to match the VM's double charge on the update expression.
- `getAllConfig()` polls incrementally by echoing the hub's watermark and merging the delta, falling back to a full fetch on older hubs.
- `_deriveCoinPrefix()` delegates to `endpoints.coinPrefix()` as a single source of truth, with unchanged behavior.

### Fixed
- The keep-alive connection pool now selects `https.Agent` or `http.Agent` by scheme.
- Corrected the README quick-start example, which used a bare host that resolved to a broken URL.
- Updated a stale `get_actions` count assertion in the smoke suite.
- `createTx()` forwards the optional `feeQuote` parameter, which was previously discarded and silently omitted the protocol-fee output.
- The hub connector starts each call at the last-good endpoint instead of always trying endpoints in fixed order.

### Added
- `ExplorerClient` wrappers for the remaining REST endpoints, including dispenser, order and swap lifecycle queries, `getPrices`, `getPriceSnapshots`, `getMempool` and `getNetwork`.
- An `.env.example` template listing the SDK's environment variables with safe regtest defaults.
- Public-host defaults with zero-config hub discovery, so constructing the SDK with only a `network` targets the public encoder, hub and explorer.
- Unit coverage for endpoint resolution, lazy hub overlay and the downgrade guard.

### Changed
- Expanded the `getStatus()` type doc to describe its actual response shape.
- Committed `package-lock.json` and switched the Docker image to `npm ci` so installs resolve a byte-identical dependency tree.

### Removed
- Dropped the unused wall-clock `getCurrentTime()` helper; expirations derive from `block_time` instead.

### Security
- `extractServiceEndpoints()` refuses to replace an `https` base with a non-`https` hub-discovered endpoint unless `allowInsecureEndpoints` is set.
- Pinned `diff` to `^8.0.4` to remediate GHSA-73rr-hh4g-fpgx without a breaking `mocha` downgrade.

## [1.13.2] - 2026-05-28

### Security
- Pinned `serialize-javascript` to `^7.0.5`, remediating GHSA-5c6j-r48x-rmvq and GHSA-qj8w-gfj5-8c6v in a transitive dev dependency.

## [1.13.1] - 2026-05-28

### Security
- Pinned `qs` to `^6.15.2`, remediating GHSA-q8mj-m7cp-5q26.

## [1.13.0] - 2026-04-24

### Added

- `WalletUtils.signMultisigPsbt(psbtHex, wif)` signs every input of a PSBT without finalizing, so cosigners can sign independently before a threshold merge.
- `WalletUtils.finalizeMultisigPsbt(psbtHex)` finalizes a PSBT whose inputs have reached their signature threshold and returns broadcastable tx hex, txid and the finalized PSBT.

### Developer notes

- Both methods wrap bitcoinjs-lib's `signAllInputs` and `finalizeAllInputs` to support the sign, merge, then finalize workflow of N-of-M multisig.
- Taproot MuSig2 still goes through `WalletUtils.signEcdsa` plus `sdk.musig2.*` aggregation, which needs no PSBT-level partial-sig stacking.
- The release is purely additive; `signPsbt` is unchanged.

## [1.12.0] - 2026-04-24

### Added

- `WalletUtils.signEcdsa(msgHash, secretKey)` produces a DER-encoded ECDSA signature over a 32-byte sighash, following BIP-66 with no sighash flag byte appended.

### Developer notes

- The release is purely additive and adds no new package; existing signing paths are unchanged.
- The compact-to-DER converter is a small inline implementation, avoiding a full transaction-library import for a one-call primitive.

## [1.11.0] - 2026-04-24

### Added
- `XChainWallet.deriveMultisigAddress({ scriptTemplate, scheme, network? })` derives a multisig address for the p2sh-multisig, p2wsh-multisig and taproot-musig2 templates.
- `XChainSDK.deriveMultisigAddress(params)` convenience passthrough.

### Developer notes
- The method is render-only and pure, so the signing, encoder and explorer surfaces are unchanged.
- `scriptTemplate` is the source of truth; the `network` parameter only selects the bech32 prefix and address-version bytes.
- Using `pubkey` rather than `internalPubkey` on `p2tr` is intentional, since a MuSig2 aggregate is already the final output key.

## [1.10.0] - 2026-04-24

### Added
- `MuSig2` exposes BIP327 primitives (`aggregateKeys`, `sortKeys`, `generateNonce`, `aggregateNonces`, `startSession`, `partialSign`, `verifyPartial`, `aggregateSignatures`) whose output verifies as a single BIP340 Schnorr signature.
- Every `XChainSDK` instance carries a shared `MuSig2` instance at `sdk.musig2`, available without a network.
- `ExplorerClient` gained `getStakes`, `getDelegations`, `getValidators` and `getValidatorRewards`, with matching `XChainSDK` passthroughs.
- `SDKMuSigError` wraps MuSig2 failures with eight machine-readable codes.
- New unit coverage for MuSig2 roundtrips and the four staking endpoints.

### Developer notes
- The release is purely additive and changes no existing method signature.
- Dependencies `@brandonblack/musig`, `@noble/curves` and `@noble/hashes` are pinned exactly.
- The staking getters land here because the wallet's staking dashboards need them.

## [1.9.1] - 2026-04-24

### Added
- `ExplorerClient.getCoinpays(query, type, opts)` queries COINPAY records by block or address.
- `ExplorerClient.getCoinpayExpires(query, type, opts)` queries COINPAY expirations.
- `ExplorerClient.getCoinpayObligations(query, type, opts)` returns obligations with status, payer, payee, amount and expiration.
- `XChainSDK.getCoinpays`, `getCoinpayExpires` and `getCoinpayObligations` convenience passthroughs.

### Developer notes
- The release is purely additive and fills in client methods for endpoints the explorer already served.

## [1.9.0] - 2026-04-23

### Added
- `WalletUtils.decomposePsbt(psbtHex)` returns a normalized, vendor-agnostic view of a PSBT including per-input script type, sighash type, address, value and previous-tx info.
- `WalletUtils.txidOf(txHex)` computes the display-order txid of a signed raw transaction for both legacy and segwit serializations.
- An internal `classifyScript` helper disambiguates nested-segwit types from raw opcode bytes.
- An internal `serializePrevTx` helper converts a transaction into the shape hardware signers expect.
- `XChainSDK.decomposePsbt(psbtHex)` and `XChainSDK.txidOf(txHex)` convenience passthroughs.
- New unit coverage for `decomposePsbt` across P2WPKH, P2PKH, nested segwit and multi-input cases.

### Developer notes
- Both methods are net-new and `signPsbt` behavior is unchanged, so the version bump is minor.
- Hardware signer integration consumes these through dependency injection, keeping bitcoinjs-lib out of the wallet core's dependency graph.

## [1.8.1] - 2026-04-23

### Fixed
- Coin-paid dispenser creates are no longer rejected for a missing `GET_TICK`; the required set narrowed and a cross-field check now requires either `GET_TICK` or `GET_COIN`.

### Added
- Validator coverage for coin-paid and token-paid dispenser creates and for the new cross-field requirement.

## [1.8.0] - 2026-04-07

### Added
- Staking actions STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION and CLAIM_REWARDS, with formats, validation and convenience methods.
- `sdk.submitAction()` runs the full encode, sign, broadcast and wait pipeline in one call, including automatic P2SH two-phase handling.
- `sdk.session(wif)` returns a bound wallet object so a WIF and pubkey need not be passed into every call.
- `sdk.estimateFees()` performs a dry-run fee calculation and returns a reusable PSBT to avoid double-encoding.
- `UTXOCache` tracks UTXOs with speculative change outputs, preventing double-spends on rapid sequential transactions.
- `sdk.waitForAction(txid)` resolves over a WebSocket and polling hybrid when the indexer processes a transaction.
- `sdk.workflows` provides high-level multi-step recipes such as `issueAndDistribute`, `createDispenser` and `stakeAndDelegate`.
- `CrossChainHelper` coordinates actions across multiple SDK instances.
- `npm run repl` drops into a Node REPL with a pre-configured SDK and custom commands.
- `SDKActionError` covers lifecycle failures such as confirmation timeout and indexer rejection.
- Encoder errors now carry structured indexer rejection data in `details.context`.
- TypeScript definitions and new exports for `WalletSession`, `CrossChainHelper`, `UTXOCache`, `startREPL`, `SDKActionError` and `SDKMessagingError`.

## [1.7.0] - 2026-04-07

### Added
- A `COIN` field in every MESSAGE format enables sending messages to any address on any supported chain.
- `MessagingUtils.getAllMessages()` queries multiple explorers in parallel and merges the results.
- `getAllMessagesForAddress()` on `XChainSDK` queries every chain on the configured network tier.
- Validator support for the `COIN` field, which must be BTC, LTC or DOGE.
- Message objects returned by `getMessages()` and `getAllMessages()` carry `coin` and `chain`.

### Changed
- MESSAGE format strings became `VERSION|COIN|DESTINATION|...`.
- `MessagingUtils.send()` requires a `coin` parameter.
- `COIN` is a required MESSAGE field in the validator.

## [1.6.0] - 2026-04-07

### Added
- `MessagingUtils` provides ECIES, ECDH and AES pre-shared-key encryption plus high-level `send()` and `getMessages()` helpers.
- `SDKMessagingError` error class.
- `ExplorerClient.getPublicKey()` resolves an address to its public key.
- `sdk.messaging` plus `sendMessage()`, `getPublicKey()` and `getMessagesForAddress()` convenience methods.

### Changed
- `ENCRYPTION_METHOD` validation accepts 1 (ECIES), 2 (ECDH) and 3 (AES).

## [1.5.0] - 2026-04-07

### Added
- A network parameter registry covering all nine supported BTC, LTC and DOGE networks.
- `AuthUtils` provides challenge-response wallet ownership verification with support for custom messages.
- `WalletUtils` provides key management, address derivation and validation, PSBT signing, broadcasting and UTXO queries.
- `SDKWalletError` and `SDKAuthError` error classes.
- `broadcastTx()` and `getUTXOs()` RPC methods on `EncoderClient`.
- `sdk.wallet` and `sdk.auth` sub-objects with convenience passthroughs on `XChainSDK`.
- TypeScript definitions for the new wallet and auth surfaces.
- New runtime dependencies: bitcoinjs-lib, bitcoinjs-message, ecpair and @bitcoinerlab/secp256k1.
- Unit suites for networks, auth and wallet.

## [1.4.3] - 2026-04-06

### Changed
- Moved the coverage badge to its own line in the README.

## [1.4.2] - 2026-04-05

### Changed
- Reorganized the flat `test/` directory into subdirectories by test type.
- Added dedicated npm scripts for the smoke, integration, boundary, fuzz and chaos suites.
- `npm test` now runs only the unit suite with a 5s timeout.

## [1.4.1] - 2026-04-05

### Fixed
- Corrected broken documentation links in the README.

## [1.4.0] - 2026-04-03

### Added
- A real-time WebSocket client for streaming events from the explorer.
- Connection management with automatic reconnection and exponential backoff.
- Promise-based subscribe and unsubscribe correlated by request id.
- An event dispatch system with `on`, `off`, `once` and wildcard support.
- Automatic catch-up on reconnect via `since_action_index`.
- WebSocket lifecycle hooks for connect, disconnect, message and reconnect.
- Convenience subscription methods on `XChainSDK` for blocks, actions, addresses, tokens, markets, dispensers, coinpay requirements, order matches and network stats.
- Every convenience method returns an unsubscribe function for clean teardown.
- `connectWs()` and `disconnectWs()` methods on `XChainSDK`.
- `websocketUrl` and `websocketPort` constructor options, falling back to the explorer settings.
- The WebSocket client auto-initializes when an explorer URL is configured, and `sdk.stop()` disconnects it.
- New WebSocket tests running against an in-process mock server.

## [1.3.0] - 2026-04-03

### Added
- VM smart contract support: DEPLOY, EXECUTE, DEPOSIT and WITHDRAW actions with formats, validation and convenience methods.
- Rest-field (`...PARAMS`) support in `FormatSelector` for variable-length pipe-delimited parameters.
- DEPLOY auto hex-encodes a raw `code` parameter into the `CODE_ENCODING` field.
- `SDKContractError` error class.
- `ContractUtils` provides hex encode/decode, syntax validation, float detection, size checks and gas estimation.
- `ContractClient` binds an action index to `call()`, `deposit()`, `withdraw()` and explorer query methods.
- Eight explorer contract query methods covering contracts, state, balance, executions, deposits and withdrawals.
- `BatchBuilder` support for EXECUTE, DEPOSIT and WITHDRAW.
- TypeScript definitions and new unit coverage for the contract surface.

### Changed
- Updated the action count from 20 to 24 across the suite.
- Updated the explorer public method count from 40 to 48.
- The validator rejects DEPLOY inside a BATCH.

## [1.2.0] - 2026-04-02

### Added
- COINPAY action format, validation and the `sdk.coinpay()` convenience method for native coin DEX payment settlement.
- A COINPAY round-trip test.

### Changed
- ORDER validation allows a null or empty `GIVE_TICK` or `GET_TICK` for native coin pairs, while still requiring at least one.
- Updated the action count from 19 to 20 across the suite.

## [1.1.1] - 2026-03-31

### Changed

- Centered the badge layout in the README.
- Replaced blockchain-specific references with "XChain Platform" in the README description.
- Updated documentation links to full GitHub URLs.

## [1.1.0] - 2026-03-31

### Added

- A core action engine whose `createAction()` pipeline normalizes input, validates fields, selects a format version and serializes to a pipe-delimited ACTION string.
- A format selector that automatically picks the smallest format version fitting the provided fields.
- A validator covering per-action input rules for all 19 ACTION types.
- Pre-flight encoding validation that catches impossible encoding choices before calling the encoder.
- An explorer client wrapping all 40 REST endpoints with automatic coin prefix derivation, pagination and typed errors.
- An encoder client wrapping the `create_tx` JSON-RPC method plus a `spendP2sh()` helper for two-phase transactions.
- A hub connector providing automatic service discovery with configurable polling and change detection.
- A config resolution chain ordering constructor options above hub discovery, environment variables and defaults.
- A JSON-RPC API server exposing SDK functionality over HTTP via `npm run api`.
- Convenience action methods such as `sdk.send()`, `sdk.issue()` and `sdk.mint()`, plus `sdk.transfer()` as an alias.
- A fluent batch builder that composes BATCH actions with constraint enforcement and sub-action validation.
- Retry with exponential backoff, jitter and `Retry-After` support for transient network errors.
- Optional `onRequest`, `onResponse`, `onError` and `onRetry` hooks for monitoring network calls.
- Configurable HTTP agent options for explorer and encoder connection pooling.
- Seven typed error classes with machine-readable codes and contextual details.
- Introspection helpers `getActions()`, `getActionFormats()`, `getActionFields()` and `validateAction()`.
- An `index.js` module entry point exporting the SDK, batch builder and error classes.
- TypeScript definitions in `index.d.ts` for IDE autocomplete and type checking.
- A Browserify and Babel browser bundle build pipeline.
- A test suite spanning unit, boundary, fuzz, chaos, round-trip and smoke tests.
