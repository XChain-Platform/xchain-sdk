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
 * The TBTC, TLTC and TDOGE testnet entries are filled: each is the newest
 * checkpoint (all three share checkpoint_seq 156947) that the public explorer's
 * /<COIN>/api/checkpoint/<block_index>/verify answered verified true with
 * commitment_missing false, copied as served with the validators array in served
 * order. The mainnet entries stay null until launch.
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
 * client targets. Mainnet and regtest coins ship `null` (inert) until values land.
 * @type {Record<string, { checkpoint: object, validators: Array<{pubkey:string, weight:string, source:string}> } | null>}
 */
const PINNED = {
    // Bitcoin
    BTC:  null,   // mainnet  -- FILL AT LAUNCH
    // Read from https://explorer.xchain.io/TBTC/api/checkpoint/156941/verify (checkpoint_seq 156947), verified true.
    TBTC: {
        checkpoint: {
            chain: 'BTC', network: 'testnet',
            block_index: 156941,
            snapshot_block: 156947,
            checkpoint_seq: 156947,
            state_root: 'f22f6b49c3b8cf073dfa2876bd13ba0959093fc54c6bf306fadc0ec4aac8480d',
            state_root_version: 2,
            block_merkle_root: '7d0eefdcd395118b3a5c35e09d967d4c8f3ccc6db2a7ba96fbb4a9689d9151dd',
            block_merkle_version: 1,
        },
        validators: [
            { pubkey: '18e4c1d54c8932d51fa54e4bc0164461a0605fb801bfca21cad57fa74495c174', weight: '50000.00000000', source: 'mverify2tE4RK7QYHRXbpmj6iLabcYtpWY' },
            { pubkey: '2661bd8f42b910bbb471387b7c28eaa440fc3c99077c160a69f22859f924aa7d', weight: '50000.00000000', source: 'mverify1Q6YPNqP4UzqLoa1MpDDZUu4ogC' },
            { pubkey: '72a25832d5f9d30baf704579fc440723f03cba55098cb2aac21063bf71029bad', weight: '50000.00000000', source: 'mverify4Hoe6uqa7ZJanX7GFXDpZ6dmtyX' },
            { pubkey: '8a1215431e8143b2ebdc9fed2fe7f655ecc327c4efd66798bc4e5504a5d5b0a8', weight: '50000.00000000', source: 'mverify3LaXvGitmYx3nHa3y2LMJ1odWVc' },
            { pubkey: 'c1de91459e8bd93de9e3263c26d886058593d3fdae57ad0c1bd48ca3dd22f32a', weight: '50000.00000000', source: 'mverify5szar1XwwAjqAnPUHbA814kfHh4' },
        ],
    },
    RBTC: null,   // regtest
    // Litecoin
    LTC:  null,   // mainnet  -- FILL AT LAUNCH
    // Read from https://explorer.xchain.io/TLTC/api/checkpoint/4926448/verify (checkpoint_seq 156947), verified true.
    TLTC: {
        checkpoint: {
            chain: 'LTC', network: 'testnet',
            block_index: 4926448,
            snapshot_block: 156947,
            checkpoint_seq: 156947,
            state_root: 'ee4f9c774ddde817cd54ba6206beb8dc348eac475de756ea183115764e1af336',
            state_root_version: 2,
            block_merkle_root: '7d0eefdcd395118b3a5c35e09d967d4c8f3ccc6db2a7ba96fbb4a9689d9151dd',
            block_merkle_version: 1,
        },
        validators: [
            { pubkey: '18e4c1d54c8932d51fa54e4bc0164461a0605fb801bfca21cad57fa74495c174', weight: '50000.00000000', source: 'mverify2tE4RK7QYHRXbpmj6iLabcYtpWY' },
            { pubkey: '2661bd8f42b910bbb471387b7c28eaa440fc3c99077c160a69f22859f924aa7d', weight: '50000.00000000', source: 'mverify1Q6YPNqP4UzqLoa1MpDDZUu4ogC' },
            { pubkey: '72a25832d5f9d30baf704579fc440723f03cba55098cb2aac21063bf71029bad', weight: '50000.00000000', source: 'mverify4Hoe6uqa7ZJanX7GFXDpZ6dmtyX' },
            { pubkey: '8a1215431e8143b2ebdc9fed2fe7f655ecc327c4efd66798bc4e5504a5d5b0a8', weight: '50000.00000000', source: 'mverify3LaXvGitmYx3nHa3y2LMJ1odWVc' },
            { pubkey: 'c1de91459e8bd93de9e3263c26d886058593d3fdae57ad0c1bd48ca3dd22f32a', weight: '50000.00000000', source: 'mverify5szar1XwwAjqAnPUHbA814kfHh4' },
        ],
    },
    RLTC: null,   // regtest
    // Dogecoin
    DOGE: null,   // mainnet  -- FILL AT LAUNCH
    // Read from https://explorer.xchain.io/TDOGE/api/checkpoint/68006379/verify (checkpoint_seq 156947), verified true.
    TDOGE: {
        checkpoint: {
            chain: 'DOGE', network: 'testnet',
            block_index: 68006379,
            snapshot_block: 156947,
            checkpoint_seq: 156947,
            state_root: 'e214754e5203098ad4d132d0682634f50c1fde82c260699ac661c0f0e6f6319c',
            state_root_version: 2,
            block_merkle_root: '7d0eefdcd395118b3a5c35e09d967d4c8f3ccc6db2a7ba96fbb4a9689d9151dd',
            block_merkle_version: 1,
        },
        validators: [
            { pubkey: '18e4c1d54c8932d51fa54e4bc0164461a0605fb801bfca21cad57fa74495c174', weight: '50000.00000000', source: 'mverify2tE4RK7QYHRXbpmj6iLabcYtpWY' },
            { pubkey: '2661bd8f42b910bbb471387b7c28eaa440fc3c99077c160a69f22859f924aa7d', weight: '50000.00000000', source: 'mverify1Q6YPNqP4UzqLoa1MpDDZUu4ogC' },
            { pubkey: '72a25832d5f9d30baf704579fc440723f03cba55098cb2aac21063bf71029bad', weight: '50000.00000000', source: 'mverify4Hoe6uqa7ZJanX7GFXDpZ6dmtyX' },
            { pubkey: '8a1215431e8143b2ebdc9fed2fe7f655ecc327c4efd66798bc4e5504a5d5b0a8', weight: '50000.00000000', source: 'mverify3LaXvGitmYx3nHa3y2LMJ1odWVc' },
            { pubkey: 'c1de91459e8bd93de9e3263c26d886058593d3fdae57ad0c1bd48ca3dd22f32a', weight: '50000.00000000', source: 'mverify5szar1XwwAjqAnPUHbA814kfHh4' },
        ],
    },
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
