# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **BREAKING** `AgentSession` safety controls are enforced rather than offered: the constructor requires at least one spend ceiling, a submit requires a stable `submitOpts.idempotencyKey`, and a new operator kill switch (`pause()`/`resume()` plus a `killSwitchFile` re-read on every submit) halts a running session before evaluation or broadcast; `allowUnbounded` / `allowUnkeyedSubmits` opt back out ().
- **BREAKING** `X402Client` is now fail-closed on spend: omitting `maxAmount` applies a conservative default per-payment ceiling (over-ceiling offers throw `X402_PRICE_TOO_HIGH` before paying); unbounded spending is an explicit opt-in via `maxAmount: 'unbounded'`/`Infinity` or `allowUnbounded: true` ().
- **BREAKING** `X402Client.fetchUrl` no longer double-pays on retry: both post-broadcast leak paths now throw one `X402_PAYMENT_AMBIGUOUS` error carrying `details.txid`/`details.resume`, and `fetchUrl(url, init, { resume })` adopts the in-flight payment instead of broadcasting a new one (replaces the `X402_PAYMENT_NOT_ACCEPTED` throw) ().

### Fixed
- BigInt satoshi values serialize as quoted decimal strings, converging on the form the encoder parses and the indexer already pins ().
- buildRecoverySpend reconciles inputs and outputs in exact u64, so an account above 2^53 satoshi can no longer defeat its own whole-account anti-burn guard ().
- Explicit action versions run the serializer no-data-loss check instead of bypassing it, closing a silent field-drop on version-pinned actions ().
- Structurally corrupt velocity-window rows fail closed on load rather than being quarantined while spend limits reopen ().
- Stake-weighted quorum rejects a validator entry with a missing or non-numeric weight instead of lowering the quorum denominator ().
- Hardware-signing decomposition handles DOGE-scale values above 2^53 without rounding ().
- FEE_CHARGING_ACTIONS includes BET, restoring the NATIVE_FEE_FORFEIT warning it silently dropped ().
- The WebSocket ticks subscription filter no longer silently no-ops on the actions channel ().
- getContracts and both getExecutions declarations return a list envelope, matching what Explorer actually emits ().
- The preflight drift gate covers fee classification and VM gas inputs ().
- Corrected a protocol-constants header that claimed a cross-repo tripwire which does not exist ().
- Version-locked SDK helpers no longer let a caller override the version they force: `Utility.withForcedVersion` strips every spelling and throws on a mismatch, closing a silent misroute of staked assets ().
- Weighted checkpoint verification requires a valid weight and nonblank source on EVERY validator entry; a partially-weighted set used to clear the stake predicate on a shrunken denominator ().
- A checkpoint missing its commitment roots after activation is now rejected outright instead of verifying against the legacy rootless preimage ().
- Co-signer output caps compare as exact u64: an output one satoshi above a cap larger than 2^53 used to be approved ().
- review review-round fixes: verifyBalanceProof pins the sub-root slot (false-zero proof closed), opt-in submit idempotency key, co-signer sidecar fails closed without a token, compiled-push OP_RETURN preflight, network-aware oversize suggestion, attestation SSRF gate, hub-envelope parity CI check, FAMILY_SLIP44 derivation tests.

### Security
- MuSig2 key aggregation rejects a repeated participant key, which previously collapsed the policy threshold to a single signer ().
- `verifyAnchoredCheckpoint` requires the committed roots to be inside the SIGNED canonical, closing a bypass that let a signed rootless checkpoint carry attacker-chosen SPV roots ().
- `submitAction` reconciles every encoder-authored PSBT against the submitted intent before signing, blocking fund redirection and fee burn by a compromised encoder ().
- `generateNonce` refuses to reuse a `sessionId` under different signing inputs, which reused the secret nonce and disclosed the private key ().
- `CoSigner`, `CoSignerClient` and `MuSig2AgentSession` require exactly the two-key pair they can sign for, instead of funding aggregate addresses no spend path could ever unlock ().

### Removed
- `statuses` WS filter dropped from `onAction`, `onAddress` and `onOrderMatch` (and from the typed surface): no explorer channel ever populated a per-event status, so it silently returned an unfiltered stream ().

### Added
- Armed the three BTC-anchored activation copies (checkpoint commitment, EQUIV header, stake-weighted quorum) at BTC 961000, in lockstep with the indexer/hub twins.
- `ContractUtils.parseAbi(source)`: fail-closed AST reader for the optional contract `abi` display-metadata block (protocol/Contract_ABI.md).
- Escrow, vesting, and crowdsale templates declare `abi` blocks (method summaries + `view` flags), re-embedded via `sync:templates`.
- `hubApiKey` option (env fallback `HUB_API_KEY`) on the hub connector, required for `getallconfigs` against keyed hubs; public zero-config discovery should use the hub's `GET /api/v1/chain-registry` instead.

### Changed
- Re-vendor `lint-core.js` and `metering.js` byte-identical to canonical xchain-vm ().
- Re-embedded the crowdsale template via `sync:templates`, picking up the xchain-contracts saleDecimals validation from 794eae8 (; template-parity had been red since 2026-07-21).
- Address-ref compaction is now action-aware (`SDK_COMPACTABLE_BY_ACTION`): a field can be compacted for one action and emitted in full for another.

### Fixed
- Delegated dispenser opens no longer compact `GET_ADDRESS` to its `^<id>` reference form; the full address is serialized so the decoder — which cannot resolve an `^<id>` into its own address id space — keys the dispenser on the real operating address and can match payments to it. Previously a default-compacted delegated dispenser opened keyed on the literal `^<id>` token and silently never dispensed. `ORDER`/`SWAP` `GET_ADDRESS` compaction is unchanged.

### Security
- CoSigner now rejects any BIP341 `sighashType` other than `SIGHASH_DEFAULT`/`SIGHASH_ALL` in `process`/`_processMulti` (and defensively in `taprootKeyPathSighash`). Previously the type was honored verbatim from the request, so a `SIGHASH_NONE`/`SINGLE`/`ANYONECANPAY` partial over an in-policy PSBT could be reassembled into a drain transaction that still verified, bypassing the output gate.

## [2.0.2] - 2026-08-02

### Fixed
- Browser and mobile bundles no longer reach for a Node filesystem: the regtest full-node sidecar is skipped unless one is present, instead of throwing on every launch.
- Taproot envelope reveals complete the commit/reveal pair rather than stranding the commit, and a failed reveal carries its recovery record out.

## [2.0.1] - 2026-08-01

### Changed
- README corrected for the npm registry release: install section added, code samples import `@dankest-llc/xchain-sdk`, version badge reads from npm.

## [1.14.1] - 2026-07-16

### Fixed
- Light-client checkpoint verification re-applies the source-deduped stake-weighted quorum via shared swq.meetsStakeThreshold, restoring the blank-source fail-closed guard ().
- Encoder and hub connector port defaults corrected to the servers' real binds (3003 / 10000) in code and tests ().
- CoSigner policyEvaluator wildcard per-tick window cap now binds when the action carries no tick, matching maxPerAction/confirmAbove ().


## [1.14.0] - 2026-06-20

### Fixed
- `src/XChainSDK.js`: the `onX()` subscription helpers discarded the promise from `ws.subscribe()`, so when the explorer never confirmed (503, dropped socket) the WS_TIMEOUT rejection was unhandled and terminated the host process ten seconds later; they now subscribe detached and warn instead.
- `src/checkpoint.js`, `src/stake_weighted_quorum.js` (new): `verifyCheckpoint` now applies the `3·Σ > 2·S` stake-weighted quorum predicate when weighting is active, derived locally from `snapshot_block` + `network`, failing closed when no weight/source is supplied; the count-based path is unchanged below the flag-day.
- `src/networks.js`: corrected Litecoin `dustThreshold` from `546` to `5460` litoshis for all three Litecoin networks; the previous value risked sub-dust outputs that nodes reject with `dust`.
- `src/messaging.js`: encrypted `messaging.send()` (methods 1/2/3) no longer throws `NO_MATCHING_FORMAT`; `encryptionMethod` is no longer placed on action params (wire format v2 carries no method slot), and `getMessages()` now infers ECIES when an encrypted body has no method field.

### Security
- `src/api.js`, `.env.example`: the optional SDK helper API now requires `Authorization: Bearer <SDK_API_KEY>` on every method except `ping`, fails closed with 401 when no key is configured, and defaults CORS to `origin: false` with an explicit `CORS_ORIGIN` opt-in.

### Changed
- `package.json`: pinned `bitcoinjs-lib` 6.1.7 and `ecpair` 2.1.0 to exact versions (dropped `^` caret) and added `"private": true` to prevent accidental `npm publish`.
- `package.json`: pinned `mathjs` to exact version `15.2.0` (dropped `^`) to keep bignumber arithmetic identical across services; `xchain-vm` already pins the same version.
- `package.json`: bumped `nock` devDependency to `^14.0.0` to align the test toolchain platform-wide; one affected test (`retry.test.js`) updated to pass a real `Error` instance for `replyWithError`.
- `src/explorer.js`, `src/XChainSDK.js`, `index.d.ts`: documented the new `getStatus()` response fields `decoder_tip` and `decoder_lag_blocks` (per-coin maps); this is a documentation-only change as the SDK wrappers already pass them through unchanged.
- `src/attestation.js`: documented in the module header that `callbackParams` elements are always delivered to contract callbacks as strings, with a cross-reference to ATTEST spec §Effects.
- `src/contracts.js`: `suggestGasLimit()` now counts C-style `for` loops an extra time via a new `_countForStatements()` helper (AST walk with acorn, regex fallback) to account for the VM's double-charging of indexed `for` loop update expressions.
- `src/hub.js`: `getAllConfig()` now polls incrementally by echoing the hub's `watermark` as `since_updated_at` and merging the delta into a cached config map, reducing bandwidth on quiet polls; falls back to a full fetch against older hubs.
- `src/explorer.js`, `src/endpoints.js`: `_deriveCoinPrefix()` now delegates to `endpoints.coinPrefix()` (shared with public-default resolution) as a single source of truth; behavior is unchanged for all 9 supported networks.

### Fixed
- `src/explorer.js`, `src/encoder.js`: the keep-alive connection pool now applies over HTTPS by selecting `https.Agent` vs `http.Agent` by scheme in a shared `_buildClient()`.
- `README.md`: corrected the quick-start example from a bare host (`explorerUrl: 'explorer.xchain.io'`) that resolved to a broken HTTP URL to the working zero-config form.
- `test/smoke/smoke.test.js`: updated the stale `get_actions` count assertion from 24 to 28.
- `src/encoder.js`: `createTx()` now forwards the optional `feeQuote` parameter to the encoder's `create_tx` RPC; it was previously discarded during `rpcParams` assembly, silently omitting the protocol-fee output.
- `src/hub.js`: the hub connector now starts each call at the last-good endpoint (sticky index, shared by all methods) instead of always trying endpoints in fixed order.

### Added
- `src/explorer.js`, `index.d.ts`: added `ExplorerClient` wrappers for all remaining REST endpoints: dispenser/order/swap lifecycle queries, `getPrices`, `getPriceSnapshots`, `getMempool`, and `getNetwork`.
- `.env.example`: added a configuration template listing the SDK's environment variables with safe regtest defaults and inline comments.
- `src/endpoints.js` (new), `src/XChainSDK.js`: public-host defaults with zero-config hub discovery; constructing the SDK with only a `network` now targets `https://encoder.xchain.io/{COIN}`, `https://hub.xchain.io/{COIN}`, and `https://explorer.xchain.io` for non-regtest networks, with hub endpoint overlay applied lazily on the first service call via `_ensureReady`.
- `test/unit/endpoints.test.js`, `test/unit/sdkConfig.test.js` (new): 29 unit cases covering `coinPrefix`, `publicDefaults`, `isRegtest`, per-network URL resolution, lazy hub overlay, and the downgrade guard.

### Changed
- `index.d.ts`: expanded `getStatus()` type doc to describe its actual response shape: `supported`/`available` coin maps plus per-coin `last_block` and `last_block_time`.
- `package-lock.json` committed to the repo (previously git-ignored) and Docker image built with `npm ci` instead of `npm install` so installs resolve a byte-identical dependency tree.

### Removed
- `src/utility.js`: removed the unused wall-clock `getCurrentTime()` helper; time-sensitive values like EXPIRATION derive from `block_time` passed via `getDefaultExpiration(block_time)`, which is unchanged.

### Security
- `src/XChainSDK.js`: `extractServiceEndpoints()` now refuses to replace an `https` base with a non-`https` hub-discovered endpoint (`_isDowngrade` check), keeping the secure default; opt out with `allowInsecureEndpoints: true`.
- Pin `diff` to `^8.0.4` via an `overrides` entry to remediate GHSA-73rr-hh4g-fpgx (low-severity DoS in jsdiff's `parsePatch`/`applyPatch`), forcing the patched version across `mocha`'s transitive path without a breaking `mocha` downgrade.

## [1.13.2] - 2026-05-28

### Security
- Pin `serialize-javascript` to `^7.0.5` via an `overrides` entry, remediating GHSA-5c6j-r48x-rmvq (high-severity RCE) and GHSA-qj8w-gfj5-8c6v (moderate DoS); the package is only a transitive dev dependency of `mocha`.

## [1.13.1] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws on null/undefined entries in comma-format arrays with `encodeValuesOnly`).

## [1.13.0] - 2026-04-24

### Added

- `WalletUtils.signMultisigPsbt(psbtHex, wif)`: sign every input of a PSBT with a WIF without finalizing, enabling each cosigner to sign independently before a threshold merge and final finalization.
- `WalletUtils.finalizeMultisigPsbt(psbtHex)`: finalize a PSBT whose inputs have accumulated their signature threshold; returns broadcastable tx hex, txid, and the finalized PSBT.

### Developer notes

- Both methods are thin wrappers around bitcoinjs-lib's `Psbt.signAllInputs` / `Psbt.finalizeAllInputs`. The split lets callers do "sign without finalizing, merge, finalize", the natural workflow for N-of-M multisig where T >= 2 cosigner partial sigs accumulate before broadcast.
- For Taproot-MuSig2 the path stays through `WalletUtils.signEcdsa` + `sdk.musig2.*` aggregation; on chain a MuSig2-aggregated signature looks like a single Schnorr sig under a P2TR output, no PSBT-level partial-sig stacking needed.
- Purely additive; existing `signPsbt` (single-key, finalize=true) is unchanged.

## [1.12.0] - 2026-04-24

### Added

- `WalletUtils.signEcdsa(msgHash, secretKey)`: produce a DER-encoded ECDSA signature over a 32-byte sighash with a 32-byte secret key, with compact-to-DER conversion following BIP-66; no sighash flag byte appended.

### Developer notes

- Purely additive; existing signing paths (PSBT signing via WIF, Schnorr message signing, MuSig2 round 1/2) are unchanged.
- Uses `@bitcoinerlab/secp256k1` (already a SDK dependency); no new package added.
- The compact-to-DER converter is a small inline implementation (~25 lines) avoiding a full PSBT/transaction library import for a one-call primitive.

## [1.11.0] - 2026-04-24

### Added
- `XChainWallet.deriveMultisigAddress({ scriptTemplate, scheme, network? })`: derive a multisig output address from a wallet-side `scriptTemplate`; supports `'p2sh-multisig'` (returns `redeemScript`), `'p2wsh-multisig'` (returns `witnessScript`), and `'taproot-musig2'` (P2TR key-path-only from aggregated x-only pubkey, returns bech32m address).
- `XChainSDK.deriveMultisigAddress(params)` convenience passthrough.

### Developer notes
- Purely additive. The signing, encoder, and explorer surfaces are unchanged; this method is render-only and pure (no network calls).
- `scriptTemplate` is the source of truth computed at `MultisigConfig` creation; this method only renders, so the `network` parameter selects bech32 prefix and address-version bytes.
- The `pubkey` field on `bitcoin.payments.p2tr` (rather than `internalPubkey`) is intentional: MuSig2 produces an aggregated pubkey that is the final output key with no further BIP341 tweaking.

## [1.10.0] - 2026-04-24

### Added
- `MuSig2`: BIP327 MuSig2 primitives wrapped from `@brandonblack/musig`; exposes `aggregateKeys`, `sortKeys`, `generateNonce`, `aggregateNonces`, `startSession`, `partialSign`, `verifyPartial`, and `aggregateSignatures`; aggregated signatures verify as single BIP340 Schnorr signatures under the aggregated x-only pubkey.
- `sdk.musig2`: every `XChainSDK` instance now has a shared `MuSig2` instance available at construction time (no network required).
- `ExplorerClient.getStakes(query, type, opts)`: passthrough to `/{COIN}/api/stakes/{QUERY}/{TYPE}`.
- `ExplorerClient.getDelegations(query, type, opts)`: passthrough to `/{COIN}/api/delegations/{QUERY}/{TYPE}`.
- `ExplorerClient.getValidators(opts)`: passthrough to `/{COIN}/api/validators`.
- `ExplorerClient.getValidatorRewards(query, type, opts)`: passthrough to `/{COIN}/api/rewards/{QUERY}/{TYPE}`.
- `XChainSDK.getStakes`, `getDelegations`, `getValidators`, `getValidatorRewards` convenience passthroughs.
- `SDKMuSigError`: typed error class wrapping MuSig2 failures with 8 error codes.
- 13 new tests in `test/unit/musig2.test.js`: input validation, 2-of-2 and 3-of-3 roundtrips, `verifyPartial`, `sortKeys`, and message-binding cases.
- 9 new tests in `test/unit/explorer.test.js` covering the four staking endpoints.

### Developer notes
- Purely additive. No existing method signatures change; no decoder/indexer/explorer/hub behavior changes.
- Dependencies added (all pinned exactly): `@brandonblack/musig@0.0.1-alpha.1`, `@noble/curves@1.9.1`, `@noble/hashes@1.8.0`; the adapter implements the 20-method `Crypto` interface on top of these.
- Phase 4 of `xchain-wallet` is the motivating consumer: Taproot-MuSig2 needs these primitives for key aggregation, nonce coordination (2-round: nonce commit then partial sig), and partial signing across cosigners.
- Staking getters also land in this release because the wallet's §42.7 Staking dashboard and §42.7.5 Operator dashboard need them at the start of Phase 4; the hub's validator metrics are not yet exposed via HTTP API and the bump for §42.7.5 is deferred.
- Full SDK unit test count is now 559 passing (+18 from this release).

## [1.9.1] - 2026-04-24

### Added
- `ExplorerClient.getCoinpays(query, type, opts)`: passthrough to `/{COIN}/api/coinpays/{QUERY}/{TYPE}` (query by `block` or `address`).
- `ExplorerClient.getCoinpayExpires(query, type, opts)`: passthrough to `/{COIN}/api/coinpay_expires/{QUERY}/{TYPE}`.
- `ExplorerClient.getCoinpayObligations(query, type, opts)`: passthrough to `/{COIN}/api/coinpay_obligations/{QUERY}/{TYPE}`; returns obligations with status, `payer_address`, `payee_address`, `coin_amount`, and `expiration`.
- `XChainSDK.getCoinpays`, `getCoinpayExpires`, `getCoinpayObligations` convenience passthroughs.

### Developer notes
- Purely additive. No existing method signatures change; no DB or encoder behavior changes. Patch version bump.
- These endpoints have been present in `xchain-explorer` since the original COINPAY rollout; this release fills in the matching SDK client methods.

## [1.9.0] - 2026-04-23

### Added
- `WalletUtils.decomposePsbt(psbtHex)`: vendor-agnostic PSBT introspection returning a normalized `{ txVersion, locktime, network, inputs[], outputs[] }` shape with per-input `scriptType`, `sighashType`, `address`, `value`, and a Trezor `refTxs`-shaped `prevTxInfo` when `nonWitnessUtxo` is present.
- `WalletUtils.txidOf(txHex)`: compute the display-order txid of a signed raw transaction, handling both legacy and segwit serializations.
- Internal `classifyScript(scriptBuf, redeemScriptBuf?)` helper that inspects raw opcode bytes to disambiguate nested-segwit types without round-tripping through `bitcoin.payments`.
- Internal `serializePrevTx(tx)` helper that converts a bitcoinjs-lib `Transaction` into Trezor Connect's `RefTransaction` shape.
- `XChainSDK.decomposePsbt(psbtHex)` and `XChainSDK.txidOf(txHex)` convenience passthroughs.
- 7 new tests in `test/unit/wallet.test.js` under `decomposePsbt()`: argument validation, P2WPKH, P2PKH, P2SH-P2WPKH, multi-input/output, and version/locktime/sequence cases.

### Developer notes
- `decomposePsbt` and `txidOf` are net-new; pre-existing `signPsbt` behavior and return shape are unchanged. Minor-version bump because the public surface grows.
- Hardware signer integration in `xchain-wallet` consumes these via the existing `SDKRegistry` DI pattern, keeping `bitcoinjs-lib` out of `@xchain-wallet/core`'s dependency graph.
- Full SDK unit test count is now 531 passing (+7 decomposePsbt cases).

## [1.8.1] - 2026-04-23

### Fixed
- `Validator._validateDispenser`: coin-paid dispenser creates were incorrectly rejected with `MISSING_REQUIRED_FIELD: GET_TICK`; required-fields set narrowed to `['GIVE_TICK', 'GIVE_AMOUNT', 'GET_AMOUNT']` with a new cross-field check requiring either `GET_TICK` or `GET_COIN`.

### Added
- 4 new tests in `test/unit/validator.test.js` covering coin-paid accept, token-paid accept, reject when neither `GET_TICK` nor `GET_COIN` is set, and that `GIVE_TICK`/`GIVE_AMOUNT`/`GET_AMOUNT` remain required.

## [1.8.0] - 2026-04-07

### Added
- **Staking actions**: STAKE, UNSTAKE, DELEGATE, REVOKE_DELEGATION, CLAIM_REWARDS, format definitions, validation (TIER, SIGNING_PUBKEY, CHAINS), convenience methods, round-trip tests (BTC-only)
- **Transaction Lifecycle Manager** (`sdk.submitAction()`): full encode, sign, broadcast, and wait pipeline in a single call, with automatic P2SH two-phase handling and progress callbacks
- **Wallet Session** (`sdk.session(wif)`): bound wallet object that bundles address/key/UTXO state with action convenience methods, eliminates passing WIF/pubkey into every call
- **Fee Estimation** (`sdk.estimateFees()`): dry-run fee calculation via encoder, returns fee in satoshis plus reusable PSBT to avoid double-encoding
- **UTXO Cache** (`UTXOCache`): in-memory UTXO tracker with speculative change outputs, prevents double-spend on rapid sequential transactions from the same address
- **Event-Driven Confirmation** (`sdk.waitForAction(txid)`): WebSocket + polling hybrid that resolves when the indexer processes a transaction, with configurable timeout and validity checks
- **Workflow Recipes** (`sdk.workflows`): high-level multi-step helpers, `issueAndDistribute`, `issueAndMint`, `createDispenser`, `createOrder`, `cancelOrder`, `stakeAndDelegate`, `deployAndFund`, `distributeDividend`
- **Cross-Chain Helper** (`CrossChainHelper`): coordinate actions across multiple SDK instances, `createSwap`, `link`, `parallel`, `waitForAll`, `getAllBalances`
- **Interactive REPL** (`npm run repl`): drops into a Node.js REPL with pre-configured SDK, custom `.actions`, `.status`, `.fields` commands
- **SDKActionError** error class for lifecycle failures (confirmation timeout, action rejected by indexer)
- Enriched encoder error context: `details.context` now carries structured indexer rejection data from `body.error.data`
- 5 new round-trip tests for staking actions (520 total passing)
- TypeScript definitions for all new types, classes, and methods
- New exports: `WalletSession`, `CrossChainHelper`, `UTXOCache`, `startREPL`, `SDKActionError`, `SDKMessagingError`

## [1.7.0] - 2026-04-07

### Added
- Cross-chain messaging: `COIN` field (BTC, LTC, DOGE) in all MESSAGE formats enables sending messages to any address on any chain
- `getAllMessages()` in `MessagingUtils`: queries multiple explorers in parallel and merges results
- `getAllMessagesForAddress()` convenience method on `XChainSDK`: automatically queries all chains (BTC, LTC, DOGE) on the configured network tier
- `COIN` field validation in `Validator` (must be BTC, LTC, or DOGE)
- `coin` and `chain` fields on message objects returned by `getMessages()` / `getAllMessages()`

### Changed
- MESSAGE format strings updated to `VERSION|COIN|DESTINATION|...`
- `send()` in `MessagingUtils` now requires `coin` parameter
- `COIN` added to MESSAGE required fields in validator

## [1.6.0] - 2026-04-07

### Added
- `src/messaging.js`: `MessagingUtils` class: ECIES encrypt/decrypt (ephemeral keypair per message, AES-256-GCM), ECDH session key exchange and shared secret derivation, AES pre-shared key encrypt/decrypt, public key lookup via explorer, high-level `send()` and `getMessages()` with automatic encryption and decryption
- `SDKMessagingError` error class in `src/errors.js`
- `getPublicKey()` method on `ExplorerClient` for address-to-pubkey resolution
- `sdk.messaging` sub-object on `XChainSDK` with 3 top-level convenience methods: `sendMessage()`, `getPublicKey()`, `getMessagesForAddress()`

### Changed
- `src/validator.js`: `ENCRYPTION_METHOD` validation updated to accept `[1, 2, 3]` (1=ECIES, 2=ECDH, 3=AES)

## [1.5.0] - 2026-04-07

### Added
- `src/networks.js`: network parameter registry for all 9 supported BTC/LTC/DOGE networks (ported from xchain-encoder CryptoNetworks)
- `src/auth.js`: `AuthUtils` class: challenge-response wallet ownership verification (`generateChallenge`, `signMessage`, `verifyOwnership`, `verifyMessage`), supports custom messages for SDK-independent verification
- `src/wallet.js`: `WalletUtils` class: key management (`importWIF`, `generateKeyPair`), address derivation (`deriveAddress` with P2PKH/P2WPKH/P2SH-P2WPKH), address validation (`validateAddress`), PSBT signing (`signPsbt`), transaction broadcasting (`broadcastTx`), UTXO queries (`getUTXOs`)
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
- Fix broken documentation links in README, point to correct `components/sdk/` path in xchain-documentation

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

- **Core Action Engine**, `createAction()` pipeline: normalize input, validate fields, select optimal format version, serialize to pipe-delimited ACTION string
- **Format Selector**, automatically picks the smallest format version that fits the provided fields (e.g., ISSUE v1 for description-only updates vs v0 for full creates)
- **Validator**, per-action input validation for all 19 ACTION types: TICK name rules, character restrictions, numeric bounds, lock values, FIAT codes, BATCH constraints, required field enforcement
- **Pre-flight Encoding Validation**, catches impossible encoding choices (e.g., OP_RETURN with oversized data, MULTISIGN without compressedPubKey) before calling the encoder
- **Explorer Client**, HTTP client wrapping all 40 xchain-explorer REST API endpoints with automatic coin prefix derivation from network string, pagination support, and typed errors
- **Encoder Client**, JSON-RPC client wrapping xchain-encoder's `create_tx` method with full parameter support, plus `spendP2sh()` helper for P2SH/P2WSH two-phase transactions
- **Hub Connector**, xchain-hub integration for automatic service discovery via `getallconfigs`, with configurable polling interval and config change detection
- **Config Resolution Chain**, constructor options > hub-discovered > environment variables > defaults
- **JSON-RPC API Server**, 52 methods exposing all SDK functionality over HTTP (run via `npm run api`)
- **Convenience Action Methods**, `sdk.send()`, `sdk.issue()`, `sdk.mint()`, and 16 more shorthand methods for all ACTION types, plus `sdk.transfer()` as an alias for `sdk.send()`
- **Batch Builder**, fluent API for composing BATCH actions: `sdk.batch().send({...}).mint({...}).build()` with automatic BATCH constraint enforcement and sub-action validation
- **Retry with Exponential Backoff**, configurable retry logic for transient network errors (HTTP 429, 502, 503, 504, timeouts, connection resets) with jitter and Retry-After header support
- **Request Hooks**, optional `onRequest`, `onResponse`, `onError`, `onRetry` callbacks for monitoring all network calls to explorer and encoder
- **Connection Pooling**, configurable HTTP agent options (maxSockets, keepAlive, keepAliveMsecs, maxFreeSockets) for explorer and encoder clients
- **Error Class Hierarchy**, 7 typed error classes (SDKError, SDKValidationError, SDKFormatError, SDKEncoderError, SDKExplorerError, SDKHubError, SDKConfigError) with machine-readable codes and contextual details
- **Introspection Helpers**, `getActions()`, `getActionFormats()`, `getActionFields()`, `validateAction()` for programmatic discovery of supported actions and their parameters
- **Module Entry Point**, `index.js` exporting XChainSDK, BatchBuilder, and all error classes for library use via `require('xchain-sdk')`
- **TypeScript Definitions**, `index.d.ts` with full type coverage for IDE autocomplete and type checking
- **Browser Bundle**, Browserify + Babel build pipeline: `npm run build` (minified) and `npm run build:dev` (development)
- **Test Suite**, 551 tests across 12 test files: unit, boundary, fuzz, chaos, round-trip, and smoke tests
