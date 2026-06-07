# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.14.0] - 2026-06-06

### Changed
- `package.json` — pinned `bitcoinjs-lib` 6.1.7, `ecpair` 2.1.0 to exact versions (dropped the `^` caret ranges) so installs resolve a byte-identical dependency tree, matching the versions already frozen in `package-lock.json`. Also added `"private": true` to guard against an accidental `npm publish` of the SDK propagating unpinned ranges to downstream consumers. No source changes.
- `package.json` — pinned `mathjs` to the exact version `15.2.0` (dropping the `^15.2.0` caret) to keep the bignumber implementation used for amount/fee arithmetic identical across services. `mathjs` is consensus-relevant math shared platform-wide, where `xchain-vm` already pins the same exact version; aligning the SDK (and explorer) to an exact pin prevents any service from independently drifting onto a newer patch through a stray `npm install`. Lockfile regenerated. No source changes.
- `package.json` — bumped the `nock` devDependency from `^13.5.6` to `^14.0.0` to align the test toolchain across the platform (other services already run nock 14). nock 14 rebuilt its HTTP interceptor on `@mswjs/interceptors`, which changed `replyWithError` semantics: a plain object literal is no longer surfaced to the HTTP client as a socket error. The one affected test (`test/unit/retry.test.js`, the ECONNRESET-then-success case) now passes a real `Error` instance carrying the `code` so the simulated network error propagates as before. No production code is affected — `nock` is dev-only and never bundled.
- `src/explorer.js`, `src/XChainSDK.js`, `index.d.ts` — documented the two new `getStatus()` response fields, `decoder_tip` and `decoder_lag_blocks` (per-coin maps). `decoder_tip` is the decoder's highest *processed* block and `decoder_lag_blocks` is `decoder_tip - last_block` (>= 0), so a consumer can detect a stalled indexer from a single `getStatus()` call rather than a separate out-of-band tip query. Both are `null` for a coin when the decoder tip is unavailable. The fields are deliberately named for what they measure — the indexer→decoder slice of the pipeline, NOT the coin node's chain tip: the explorer never talks to a coin node, so a decoder lagging the chain node is not visible through `/status` and is instead surfaced by the decoder's own `health()` RPC. The SDK wrappers are thin pass-throughs of the explorer `/status` body, so the fields already flow through unchanged — this is a documentation-only change (method comments + the `index.d.ts` JSDoc).
- `src/attestation.js` — documented in the module header that `callbackParams` are always delivered to the contract callback as strings. Every element of the array passed to `xchain.attestation.request(...)` is string-coerced by the VM parameter bus regardless of its original type (`[42, true, null]` arrives as `['42', 'true', 'null']`), so contract authors must re-parse numeric/boolean context inside the callback with `parseInt` / `parseFloat` / `JSON.parse`. Cross-referenced to the ATTEST spec §Effects.
- `src/contracts.js` — `suggestGasLimit()` now accounts for the VM's double-charging of indexed `for` loops. The gas-metering transform injects a computation charge for **both** the loop body and the update expression, so an indexed `for` loop costs ~2× per iteration versus `while` / `do-while` / `for-in` / `for-of` (which have no update slot). The heuristic previously weighted every loop keyword equally and therefore underestimated the budget for contracts using indexed `for` loops by roughly 50%. It now counts each C-style `for` an extra time — via a new `_countForStatements()` helper that walks the AST with acorn (counting only `ForStatement` nodes) and falls back to a header-shape regex when acorn is unavailable — and the rationale string reports the indexed-`for` count. Suggested limits for contracts using indexed `for` loops rise toward the true cost (a strict improvement in accuracy); contracts without indexed `for` loops are unaffected.
- `src/hub.js` — `getAllConfig()` now polls the hub incrementally: it echoes the hub's `watermark` back as `since_updated_at` and merges the returned delta into a cached config map, so a quiet poll transfers near-nothing instead of re-fetching the full config tree every 60s. The merge is exact because the hub's config table is upsert-only (rows are never deleted), so applying successive deltas reconstructs exactly what a full fetch would have returned; callers (`extractServiceEndpoints`) still receive the same full nested map. Falls back to a full fetch on the first call, after a restart, or against an older hub that reports no watermark, so the change is backward-compatible.
- `src/explorer.js`, `src/endpoints.js` — the network→coin-prefix mapping is now a single source of truth. `explorer.js` previously held its own `COIN_PREFIX_MAP`; `_deriveCoinPrefix()` now delegates to `endpoints.coinPrefix()` (shared with the public-default resolution), with the invalid-network error listing `networks.getSupportedNetworks()`. `coinPrefix()` is strict — it rejects an unknown chain or network part (e.g. `bitcoin-foo`) rather than defaulting to mainnet. Behavior is unchanged for all 9 supported networks (covered by existing explorer tests).

### Fixed
- `src/explorer.js`, `src/encoder.js` — the keep-alive connection pool now applies over HTTPS. Both clients hardcoded an `http.Agent`, which axios ignores on an `https://` base, so pooling silently no-op'd against public hosts. The agent is now chosen by scheme (`https.Agent` for https bases) in a shared `_buildClient()`.
- `README.md` quick-start — the documented example passed `explorerUrl: 'explorer.xchain.io'` as a bare host, which resolved to the broken `http://explorer.xchain.io:8080`. Updated to show the working zero-config form and the "pass full URLs with scheme when overriding" rule.
- `test/smoke/smoke.test.js` — fixed the stale `get_actions` count assertion (24 → 28; the 28 canonical action types).
- `src/encoder.js` — `createTx()` now forwards the optional `feeQuote` parameter (`{ address, amount }`) to the encoder's `create_tx` RPC. The documented parameter was previously discarded during `rpcParams` assembly, so any caller passing a hub-provided protocol fee quote silently built a transaction without the protocol-fee output. The encoder already validates and injects `feeQuote` server-side; this restores the documented passthrough so the fee output is included as intended.
- `src/hub.js` — the hub connector now remembers the last endpoint that answered and starts each call there (wrapping through the remaining endpoints), instead of always trying the configured endpoints in fixed order. Previously, when the first endpoint was degraded enough to hit the request timeout, every `getAllConfig()` and `ping()` call paid the full timeout penalty before falling back — and then retried that same endpoint first on the next call. Both methods now share a sticky-last-good index, so the connector sticks to a known-good endpoint until it too fails, then rotates to the next responder.

### Added
- `src/explorer.js` / `index.d.ts` — added the remaining `ExplorerClient` wrappers so consumers can query every explorer REST endpoint through the SDK convenience layer. New methods: the dispenser/order/swap lifecycle queries (`getDispenserCancels`, `getDispenserCloses`, `getDispenserExpires`, `getDispenserEdits`, `getOrderCancels`, `getOrderEdits`, `getOrderExpires`, `getOrderMatches`, `getSwapCancels`, `getSwapEdits`, `getSwapExpires`), plus `getPrices`, `getPriceSnapshots`, `getMempool`, and `getNetwork`. Each follows the established wrapper pattern (`coin` is bound at construction; `query`/`type` map to the route segments). Previously these endpoints were reachable only via raw HTTP, blocking SDK-based wallet history views and third-party integrations.
- `.env.example` — added a configuration template listing the environment variables the SDK reads (default network and service endpoints for explorer/encoder/hub/websocket), with safe regtest defaults and inline comments.
- `src/endpoints.js` (new) + `src/XChainSDK.js` — **public-host defaults with zero-config hub discovery.** Constructing the SDK with only a `network` (no explicit URLs/env) now targets the live platform for non-regtest networks instead of `localhost`: resolution is `options > env > public default > localhost`. Public defaults are full `https://` URLs carrying the platform's coin-path routing — `https://encoder.xchain.io/{COIN}` and `https://hub.xchain.io/{COIN}` (the encoder/hub clients send to the URL verbatim) — while the explorer default stays bare (`https://explorer.xchain.io`) because the explorer client builds its own `/{COIN}/api/...` path. `coinPrefix()` derives the prefix (BTC/TBTC, LTC/TLTC, DOGE/TDOGE). Any `*-regtest` network is unchanged (localhost). The constructor also wires a `https://hub.xchain.io` connector for non-regtest networks and discovers endpoints lazily: the first service call transparently awaits one hub fetch (`_ensureReady`, memoized) and overlays hub-discovered endpoints onto the live clients via a new `client.setBase(...)`, falling back to the hardcoded hosts on hub failure (never throws). `HUB_API_HOST`/`HUB_PORT` now also trigger hub creation. No `await sdk.init()` required — it remains available to force discovery up front.
- `test/unit/endpoints.test.js`, `test/unit/sdkConfig.test.js` (new) — unit coverage for the public-default resolution: `coinPrefix`/`publicDefaults`/`isRegtest`, per-network URL resolution + precedence, the lazy hub overlay (overlay/memoization/hub-failure swallow), and the downgrade guard. 29 cases.

### Changed
- `index.d.ts` — expanded the `getStatus()` type doc to describe its actual response shape. The explorer status endpoint now returns `supported`/`available` coin maps plus per-coin `last_block` and `last_block_time` maps (highest indexed block and its block_time); the doc notes these can be compared against the chain tip to detect indexer lag. Previously the doc said only "Get explorer service status," giving no hint that sync-position data was available.
- Dependency installs are now reproducible: `package-lock.json` is committed to the repo (previously git-ignored) and the Docker image is built with `npm ci` instead of `npm install`. `npm ci` installs the exact dependency tree recorded in the lockfile and fails the build if the lockfile is missing or out of sync with `package.json`, so a build can no longer silently pick up newer transitive dependency versions than were tested. This matters most for the SDK, which ships to external developers.

### Removed
- `src/utility.js` — removed the unused wall-clock `getCurrentTime()` helper (it returned `Date.now()`-derived seconds). Nothing in the SDK called it; time-sensitive XChain values such as EXPIRATION derive from a block timestamp passed in explicitly via `getDefaultExpiration(block_time)`, which is unchanged. Dropping it from the public SDK surface keeps consumers from reaching for non-deterministic wall-clock time where a block timestamp is the correct input.

### Security
- `src/XChainSDK.js` — hub discovery cannot downgrade a secure default. `extractServiceEndpoints()` returns a bare host + port, so a hub publishing internal endpoints would otherwise replace the `https://` public default with a `http://host:port` endpoint on the first call. The overlay (`_isDowngrade`) now refuses to replace an `https` base with a non-`https` endpoint (keeps the secure default, warns once); only full `https://` endpoints from the hub are applied. Opt out with the `allowInsecureEndpoints: true` option (e.g. trusted private networks). No effect on http/localhost bases.
- Pin `diff` to `^8.0.4` via an `overrides` entry, remediating GHSA-73rr-hh4g-fpgx (low-severity DoS in jsdiff's `parsePatch` / `applyPatch`). The package is present only as a transitive dev dependency of `mocha`, which pins `^7.0.0` (a vulnerable range — the advisory covers `6.0.0 - 8.0.2`, so the fix requires `>= 8.0.3`); the override forces the patched `8.0.4` across all transitive paths so `npm audit` no longer flags it, without the breaking `mocha` downgrade that `npm audit fix --force` would otherwise apply. `8.0.4` is the version `sinon` already resolves, so `mocha`'s diff-reporter API usage (`createPatch` / `diffWordsWithSpace`) is unaffected.

## [1.13.2] - 2026-05-28

### Security
- Pin `serialize-javascript` to `^7.0.5` via an `overrides` entry, remediating GHSA-5c6j-r48x-rmvq (high-severity RCE via `RegExp.flags` / `Date.prototype.toISOString()`) and GHSA-qj8w-gfj5-8c6v (moderate CPU-exhaustion DoS via crafted array-like objects). The package is present only as a transitive dev dependency of `mocha`, which pins an older range; the override forces the patched version across all transitive paths so `npm audit --audit-level=high` no longer flags it.

## [1.13.1] - 2026-05-28

### Security
- Pin `qs` to `^6.15.2` via an `overrides` entry, remediating GHSA-q8mj-m7cp-5q26 (moderate DoS: `qs.stringify` throws a `TypeError` on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set). The override forces the patched version across all transitive dependency paths.

## [1.13.0] - 2026-04-24

### Added

- `WalletUtils.signMultisigPsbt(psbtHex, wif)` — sign every input of a PSBT with a WIF without finalizing. Used by xchain-wallet's §22.3 classical (P2SH / P2WSH) multisig flow: each cosigner signs independently and the resulting partial-sig-laden PSBTs merge naturally because bitcoinjs-lib's PSBT format stacks `partialSig` entries under each input. The merged PSBT can then be finalized once threshold is met.
- `WalletUtils.finalizeMultisigPsbt(psbtHex)` — finalize a PSBT whose inputs have already accumulated their signature threshold. Returns the broadcastable tx hex + txid + the finalized PSBT.

### Developer notes

- Both methods are thin wrappers around bitcoinjs-lib's `Psbt.signAllInputs` / `Psbt.finalizeAllInputs`. The split lets callers do "sign without finalizing → merge → finalize" — the natural workflow for N-of-M multisig where T ≥ 2 cosigner partial sigs accumulate before broadcast.
- For Taproot-MuSig2 the path stays through `WalletUtils.signEcdsa` + `sdk.musig2.*` aggregation; on chain a MuSig2-aggregated signature looks like a single Schnorr sig under a P2TR output, no PSBT-level partial-sig stacking needed.
- Purely additive; existing `signPsbt` (single-key, finalize=true) is unchanged.

## [1.12.0] - 2026-04-24

### Added

- `WalletUtils.signEcdsa(msgHash, secretKey)` — produce a DER-encoded ECDSA signature over a 32-byte sighash with a 32-byte secret key. Used by xchain-wallet's `SoftwareSigner.signMultisigClassical` (§22.3 P2SH / P2WSH single-round multisig contributions). Compact (r||s) → DER conversion follows BIP-66 (leading-zero pad when the high bit would otherwise indicate a negative integer; trim leading zero bytes that don't affect sign). No sighash flag byte is appended — callers append SIGHASH_ALL (or whatever flag the input requires) themselves so this stays a thin ECDSA primitive.

### Developer notes

- Purely additive; existing signing paths (PSBT signing via WIF, Schnorr message signing, MuSig2 round 1 / 2) are unchanged.
- Uses `@bitcoinerlab/secp256k1` (already a SDK dependency for taproot ECC support); no new package added.
- The compact-to-DER converter is a tiny inline implementation (≈25 lines) that avoids pulling a full PSBT/transaction library in for what is conceptually a one-call primitive. The output is byte-for-byte equivalent to bitcoinjs-lib's `script.signature.encode` for the standard SIGHASH_ALL case.

## [1.11.0] - 2026-04-24

### Added
- `XChainWallet.deriveMultisigAddress({ scriptTemplate, scheme, network? })` — derive a multisig output address from a wallet-side `scriptTemplate` (the field xchain-wallet persists on `MultisigConfig.scriptTemplate` per §22.4 / §11.3.6). Three schemes:
  - `'p2sh-multisig'` — scriptTemplate `"multi:<T>:<pk1>:<pk2>:..."`. Produces a P2SH address wrapping the standard N-of-M `OP_CHECKMULTISIG` redeem script. Returns `redeemScript` (hex) for downstream PSBT construction.
  - `'p2wsh-multisig'` — same template; native-segwit witness program. Returns `witnessScript` (hex).
  - `'taproot-musig2'` — scriptTemplate `"musig2:<aggregatedXOnly>"`. The 32-byte aggregated x-only pubkey (computed by the wallet at MultisigConfig creation time via `sdk.musig2.aggregateKeys`) becomes the final P2TR output pubkey directly (key-path-only, no script tree). Returns the bech32m address; on-chain indistinguishable from single-sig P2TR.
- `XChainSDK.deriveMultisigAddress(params)` convenience passthrough.

### Developer notes
- Purely additive. The signing / encoder / explorer surface is unchanged; this method is render-only and pure (no network).
- `scriptTemplate` is the source of truth — the wallet computes it once at MultisigConfig creation and persists it. This SDK method only renders, so the wallet can call it from any chain context (the network parameter selects bech32 prefix and address-version bytes for testnet/regtest; pubkeys themselves are network-agnostic).
- The `pubkey` field on `bitcoin.payments.p2tr` (rather than `internalPubkey`) is intentional: MuSig2 produces an aggregated pubkey that is the final output key, with no further BIP341 tweaking. Spends use `sdk.musig2.partialSign` + `aggregateSignatures` to produce a single BIP340 Schnorr signature, which the SDK's existing PSBT path can finalize against the P2TR output.

## [1.10.0] - 2026-04-24

### Added
- `MuSig2` — BIP327 MuSig2 primitives wrapped from `@brandonblack/musig` (BitGo's production MuSig2 dependency, exercised on Bitcoin mainnet via `@bitgo/secp256k1`). Exposes `aggregateKeys(publicKeys, tweaks?)`, `sortKeys(publicKeys)`, `generateNonce({ publicKey, secretKey?, sessionId?, xOnlyPublicKey?, msg?, extraInput? })`, `aggregateNonces(publicNonces)`, `startSession(aggNonce, msg, publicKeys, tweaks?)`, `partialSign({ secretKey, publicNonce, sessionKey, verify? })`, `verifyPartial({ sig, publicKey, publicNonce, sessionKey })`, `aggregateSignatures(sigs, sessionKey)`. `aggregateKeys` returns `{ aggPublicKey, xOnlyPubkey, gacc, tacc }` — `xOnlyPubkey` is the 32-byte Taproot spending key. Aggregated signatures verify as single BIP340 Schnorr signatures under the aggregated x-only pubkey, so on-chain they are indistinguishable from single-sig Taproot spends (the VM / decoder / indexer / explorer / hub need no changes).
- `sdk.musig2` — every `XChainSDK` instance now has a `MuSig2` instance available at construction time (no network required). The shared instance is intentional: `@brandonblack/musig` caches secret nonces internally keyed by `publicNonce`, so `generateNonce` and `partialSign` must run on the same instance. Cross-process signing is the multisig-coordinator case and routes through PSBT-QR transport (Phase 4 Step 20), not through this accessor.
- `ExplorerClient.getStakes(query, type, opts)` — passthrough to `/{COIN}/api/stakes/{QUERY}/{TYPE}` (or `/{COIN}/api/stakes` with no args), backing the wallet's Staking dashboard (§42.7.4).
- `ExplorerClient.getDelegations(query, type, opts)` — passthrough to `/{COIN}/api/delegations/{QUERY}/{TYPE}`, backing the delegated-key display on the dashboard and the DELEGATE / REVOKE_DELEGATION authoring surfaces (§42.7.2).
- `ExplorerClient.getValidators(opts)` — passthrough to `/{COIN}/api/validators`, backing the Operator / validator dashboard (§42.7.5).
- `ExplorerClient.getValidatorRewards(query, type, opts)` — passthrough to `/{COIN}/api/rewards/{QUERY}/{TYPE}`, backing pending / lifetime rewards and the rewards-trajectory chart.
- `XChainSDK.getStakes`, `getDelegations`, `getValidators`, `getValidatorRewards` convenience passthroughs.
- `SDKMuSigError` — typed error class wrapping MuSig2 failures (`INVALID_INPUT`, `KEY_AGG_FAILED`, `NONCE_GEN_FAILED`, `NONCE_AGG_FAILED`, `SESSION_START_FAILED`, `PARTIAL_SIGN_FAILED`, `PARTIAL_VERIFY_FAILED`, `SIG_AGG_FAILED`).
- 13 new tests in `test/unit/musig2.test.js`: input validation (8 cases), 2-of-2 and 3-of-3 end-to-end roundtrips that verify the aggregated signature under BIP340 Schnorr, `verifyPartial` accept + tamper-reject cases, lexicographic `sortKeys`, and message-binding (different messages under the same key-agg produce different aggregated signatures).
- 9 new tests in `test/unit/explorer.test.js` covering the four staking endpoints (URL construction + "has method" assertions, plus the no-args fallback on `getStakes`).

### Developer notes
- Purely additive. No existing method signatures change; no decoder / indexer / explorer / hub behavior changes. Minor version bump because the public surface area grows and a new module (`MuSig2`) is exported.
- Dependencies added (all pinned exactly): `@brandonblack/musig@0.0.1-alpha.1` (MIT; alpha tag is cosmetic — code has three years of mainnet exercise through BitGo's custody stack), `@noble/curves@1.9.1` (MIT; secp256k1 point ops), `@noble/hashes@1.8.0` (MIT; sha256 for the Crypto adapter). The adapter in `src/musig2.js` implements the 20-method `Crypto` interface expected by `@brandonblack/musig` on top of these libraries — scalar ops + misc predicates come from `@brandonblack/musig/base_crypto` (pure BigInt); curve operations and tagged hashing come from `@noble/curves/secp256k1`.
- Phase 4 of `xchain-wallet` is the motivating consumer. §42.9 ships all three multisig schemes (P2SH, P2WSH, Taproot-MuSig2) in one pass; Taproot-MuSig2 needs these primitives for key aggregation, nonce coordination, and partial signing across cosigners. The PSBT-QR round-trip in Step 20 differs between single-round (P2SH / P2WSH) and two-round (MuSig2: nonce commit → partial sig) transports — `MuSig2.generateNonce` produces the 66-byte `publicNonce` that travels in round 1; `aggregateNonces` + `startSession` on each cosigner seed round 2; `partialSign` produces the 32-byte partial that travels back; the coordinator aggregates with `aggregateSignatures` and finalizes the PSBT with a single 64-byte Schnorr signature.
- Staking getters also land now because the wallet's §42.7 Staking dashboard and §42.7.5 Operator dashboard need them at the start of Phase 4 (Steps 7 + 11). The hub's validator / operator metrics surface is still internal — the `RewardTracker.getUnclaimedRewards / getRewardHistory / getTotalDistributed` methods and `ValidatorIdentity` / `SlashDetector` / `PeerManager` internals exist in `xchain-hub@2.1.0` but are not yet exposed via HTTP API. The hub bump for §42.7.5 is deferred to just before wallet Step 11 (Phase 3 Step 9 pattern — ship platform-side bumps against the concrete consumer, not speculatively).
- Full SDK unit test count is now 559 passing (+18 from this release). The 4 pre-existing unrelated failures (`MESSAGE` validation cases that expect the pre-v1.7 no-`COIN` envelope, and one `ENCRYPTION_METHOD` boundary) are untouched.

## [1.9.1] - 2026-04-24

### Added
- `ExplorerClient.getCoinpays(query, type, opts)` — passthrough to `/{COIN}/api/coinpays/{QUERY}/{TYPE}` (query by `block` or `address`). Returns the COINPAY action history recorded against matches that settled a native-coin obligation.
- `ExplorerClient.getCoinpayExpires(query, type, opts)` — passthrough to `/{COIN}/api/coinpay_expires/{QUERY}/{TYPE}`. Expirations for coinpay obligations that were not fulfilled in time.
- `ExplorerClient.getCoinpayObligations(query, type, opts)` — passthrough to `/{COIN}/api/coinpay_obligations/{QUERY}/{TYPE}`. The primary lookup for "does this address owe (or is owed) a native-coin settlement" — returns obligations joined with their current status (`pending_coinpay`, `fulfilled`, `expired`, `invalid`) and the `payer_address` / `payee_address` / `coin_amount` / `expiration` fields the payer needs to compose a COINPAY transaction.
- `XChainSDK.getCoinpays`, `getCoinpayExpires`, `getCoinpayObligations` convenience passthroughs.

### Developer notes
- Purely additive. No existing method signatures change; no DB or encoder behavior changes. Patch version bump.
- These endpoints have been present in `xchain-explorer` since the original COINPAY rollout — this release only fills in the matching SDK client methods. Motivated by the XChain Wallet §41.4 "BTCPay queue + sign" surface (Phase 3 Step 9): the wallet uses `getCoinpayObligations('<address>', 'address')` to detect pending obligations per wallet address and render the Home resume card.

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
