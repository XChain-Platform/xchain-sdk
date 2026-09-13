/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain SDK - Pinned launch trust roots (SPV light client, spec D4)
 *
 * The light client's convenience path (verifyBalance/verifyAction with no
 * `validators` supplied) asks the explorer's /checkpoint/:h/verify endpoint for
 * the qualifying validator set. Signatures and the stake-weighted quorum are
 * still checked locally, but the explorer chooses the SET, the last residual
 * trust. This module removes that: it ships an out-of-band trust root (a pinned
 * launch checkpoint plus the validator set that signed it) so the quorum is
 * checked against the pinned set, never the explorer's.
 *
 * `light.js` consults this registry automatically when a caller supplies neither
 * `validators` nor `trustedCheckpoint`, keyed by the coin prefix the call
 * targets (BTC / TBTC / RBTC / LTC / ... ). Until an entry is filled it returns
 * null and the light client behaves exactly as before (the convenience path),
 * so this module is INERT until launch values are populated.
 *
 * Validator rotation: a pinned launch set eventually stops signing later
 * checkpoints. Verifying a post-rotation checkpoint against the launch set fails
 * quorum (correctly: it is not the trust root the client pinned). The
 * rotation-safe path is to seed `light.followForward` from the pinned
 * checkpoint's committed state_root and roll the trust root forward, proving
 * each successor set against the committed stakes_root (spec §7.3). That wiring
 * is a separate step; the launch epoch is covered by the pinned set alone.
 *
 * ---- FILL AT LAUNCH --------------------------------------------------------
 * To activate, replace a coin's `null` with:
 *
 *   {
 *     // The launch checkpoint, shape per checkpoint.js canonicalCheckpoint.
 *     checkpoint: {
 *       chain: 'BTC', network: 'mainnet',
 *       block_index: <launch block height>,
 *       snapshot_block: <BTC-anchored height; gates flag-day predicates>,
 *       checkpoint_seq: <seq>,
 *       state_root: '<64-hex committed state root>',
 *       state_root_version: 1,
 *       block_merkle_root: '<64-hex committed block-merkle root>',
 *       block_merkle_version: 1,
 *     },
 *     // The oracle_publish signer set that signed that checkpoint, stake-weighted
 *     // shape per checkpoint.js verifyCheckpoint (source-deduped quorum).
 *     validators: [
 *       { pubkey: '<64-hex ed25519>', weight: '<canonical amount>', source: '<signer/delegation source>' },
 *       // ...
 *     ],
 *   }
 *
 * Source the values from the chosen launch checkpoint row and its
 * `oracle_publish` capability snapshot at that checkpoint's snapshot_block.
 * ---------------------------------------------------------------------------
 *
 ********************************************************************/

'use strict';

/**
 * Per-coin pinned trust roots. Keys are the explorer coin prefixes the light
 * client targets. All real coins ship `null` (inert) until launch values land.
 * @type {Record<string, { checkpoint: object, validators: Array<{pubkey:string, weight:string, source:string}> } | null>}
 */
const PINNED = {
    // Bitcoin
    BTC:  null,   // mainnet  -- FILL AT LAUNCH
    TBTC: null,   // testnet
    RBTC: null,   // regtest
    // Litecoin
    LTC:  null,   // mainnet  -- FILL AT LAUNCH
    TLTC: null,   // testnet
    RLTC: null,   // regtest
    // Dogecoin
    DOGE: null,   // mainnet  -- FILL AT LAUNCH
    TDOGE: null,  // testnet
    RDOGE: null,  // regtest
};

// Freeze so a pinned entry cannot be mutated at runtime once populated.
for (const k of Object.keys(PINNED)) {
    if (PINNED[k]) {
        if (PINNED[k].checkpoint) Object.freeze(PINNED[k].checkpoint);
        if (Array.isArray(PINNED[k].validators)) {
            PINNED[k].validators.forEach((v) => Object.freeze(v));
            Object.freeze(PINNED[k].validators);
        }
        Object.freeze(PINNED[k]);
    }
}
Object.freeze(PINNED);

/**
 * The pinned trust-root entry for a coin prefix, or null when none is pinned
 * (the light client then uses its convenience path). Coin lookup is
 * case-insensitive.
 * @param {string} coin  e.g. 'BTC', 'RBTC'
 * @returns {{ checkpoint: object, validators: Array<object> } | null}
 */
function getPinnedCheckpoint(coin) {
    if (coin == null) return null;
    const entry = PINNED[String(coin).toUpperCase()];
    return entry || null;
}

/**
 * The pinned validator set for a coin prefix, or null. Convenience over
 * getPinnedCheckpoint(coin)?.validators.
 * @param {string} coin
 * @returns {Array<{pubkey:string, weight:string, source:string}> | null}
 */
function getPinnedValidators(coin) {
    const entry = getPinnedCheckpoint(coin);
    return entry && Array.isArray(entry.validators) ? entry.validators : null;
}

module.exports = { getPinnedCheckpoint, getPinnedValidators, PINNED };
