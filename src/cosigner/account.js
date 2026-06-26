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
 * XChain Platform SDK - MuSig2 Account Derivation (co-signer)
 *
 * Derives the agent's 2-of-N MuSig2 P2TR spending account from the signer
 * set. This matches the wallet's `taproot-musig2` scheme
 * (wallet.js: bitcoin.payments.p2tr({ pubkey: aggregatedXOnly })): the
 * aggregated x-only key is used DIRECTLY as the Taproot output key, with NO
 * BIP341 taproot tweak. So spends are key-path signatures under the bare
 * aggregate, and the co-signer/agent sign with tweaks=[] (no tweak to
 * reconcile). This is a key-path-only output (no script commitment); the
 * 2-of-3 recovery tree, which DOES need a script-path tap tree, is a
 * separate derivation handled in a later slice.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const MuSig2  = require('../musig2.js');

bitcoin.initEccLib(ecc);

/*
 * @param {(Uint8Array|string)[]} publicKeys  the full signer set, in the agreed
 *        order (key aggregation is order-sensitive; both parties must match)
 * @param {object} [network]  bitcoinjs network (default mainnet)
 * @returns {object}
 *   aggregateXOnly {Buffer}  the 32-byte aggregated x-only key (== output key)
 *   output         {Buffer}  the P2TR scriptPubKey
 *   address        {string}  the bech32m address
 *   tweaks         {Array}   always [] for this key-path scheme - sign with no tweak
 */
function deriveMuSig2P2TR(publicKeys, network) {
    const agg = new MuSig2().aggregateKeys(publicKeys);   // throws on < 2 keys / bad pubkey
    const aggregateXOnly = Buffer.from(agg.xOnlyPubkey);
    const p2tr = bitcoin.payments.p2tr({ pubkey: aggregateXOnly, network: network || undefined });
    return {
        aggregateXOnly,
        output:  p2tr.output,
        address: p2tr.address,
        tweaks:  [],
    };
}

module.exports = { deriveMuSig2P2TR };
