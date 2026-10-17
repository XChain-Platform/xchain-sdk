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
 * XChain Platform SDK - MuSig2 PSBT Signer
 *
 * Adapts the co-signer round into a drop-in replacement for
 * sdk.wallet.signPsbt: same in (unsigned PSBT hex) and out
 * ({ txHex, txid, psbtHex }), so LifecycleManager can complete a 2-of-2
 * MuSig2 key-path spend wherever it would otherwise single-WIF sign. Wired
 * via submitOpts.signer (see lifecycle_manager.js).
 *
 * Signs every taproot input of the aggregate spend in ONE co-signer round
 * (one authorization, one budget charge, a distinct MuSig2 nonce per input).
 * The co-signer rejects a mixed-account input set; all inputs here belong to
 * the aggregate (the encoder funds the tx from that one address).
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const { SDKPolicyError } = require('../utils/errors.js');
const { NETWORKS } = require('../protocol/networks.js');
const walletSigning = require('../utils/wallet/psbt_signing.js');

// Taproot finalize/extract needs an ECC backend; idempotent, safe on load.
bitcoin.initEccLib(ecc);

function toBuf(v) { return Buffer.isBuffer(v) ? v : Buffer.from(v); }

// Index every registered network by its address prefix: the bech32 HRP when it
// has one, else pubKeyHash (only the bech32-less DOGE networks today). A prefix
// two chains share maps to null, which falls to the unknown-chain ceiling.
function indexNetworksByPrefix() {
    const byBech32 = new Map(), byPubKeyHash = new Map();
    for (const [name, net] of Object.entries(NETWORKS)) {
        const [index, key] = net.bech32 ? [byBech32, net.bech32] : [byPubKeyHash, net.pubKeyHash];
        const prior = index.get(key);
        if (prior === undefined) index.set(key, name);
        else if (prior !== null && prior.split('-')[0] !== name.split('-')[0]) index.set(key, null);
    }
    return { byBech32, byPubKeyHash };
}
const PREFIX_INDEX = indexNetworksByPrefix();

/*
 * Fee ceiling (sat/vB) applied before extractTransaction. The network object is
 * matched back to its registered name through the coin registry, then the
 * wallet's own resolveMaxFeeRate answers, so this signer stays a drop-in for
 * signPsbt on a RESOLVED network: an explicit maximumFeeRate wins; the bitcoin
 * family keeps bitcoinjs's 5000 sat/vB default; litecoin and dogecoin get the
 * encoder-derived ceilings; any other network gets the flat unknown-chain one.
 *
 * Deliberate divergence from wallet.js when NO network is supplied: wallet.js
 * treats an unset network as non-bitcoin (raised ceiling), but this signer
 * treats it as the conservative bitcoin default (null -> bitcoinjs's 5000
 * sat/vB reject). BTC is the highest-unit-value chain, so defaulting an
 * unconfigured signer to BTC protection is the safe choice and avoids silently
 * accepting an absurd fee. A low-unit-value chain (e.g. DOGE) MUST pass its
 * `network` (or an explicit maximumFeeRate) to sign ordinary high-rate fees;
 * a musig2AgentSession test twin pins this no-network behavior intentionally.
 */
function resolveMaxFeeRate(network, maximumFeeRate) {
    if (Number.isFinite(maximumFeeRate) && maximumFeeRate > 0) return maximumFeeRate;
    if (!network) return null;
    const name = network.bech32
        ? PREFIX_INDEX.byBech32.get(network.bech32)
        : PREFIX_INDEX.byPubKeyHash.get(network.pubKeyHash);
    // The wallet resolver reads only the chain part of this.network.
    return walletSigning.resolveMaxFeeRate.call({ network: name || '' });
}

/*
 * @param {object} config
 *   coSignerClient {CoSignerClient}  the agent-side round runner
 *   secretKey      {Uint8Array|hex}  the agent's 32-byte key (its MuSig2 half)
 *   network        {object}          bitcoinjs network for PSBT parsing (optional)
 *   maximumFeeRate {number}          explicit sat/vB extraction ceiling (optional)
 * @returns {function} async (psbtHex) -> { txHex, txid, psbtHex }
 */
function buildMuSig2Signer(config = {}) {
    const { coSignerClient, secretKey, network, maximumFeeRate } = config;
    if (!coSignerClient || typeof coSignerClient.sign !== 'function')
        throw new Error('buildMuSig2Signer requires a CoSignerClient');
    if (!secretKey) throw new Error('buildMuSig2Signer requires the agent secretKey');

    return async function muSig2Sign(psbtHex) {
        const psbt = bitcoin.Psbt.fromHex(psbtHex, network ? { network } : undefined);
        if (psbt.txInputs.length === 0)
            throw new SDKPolicyError('MUSIG2_NO_INPUTS', 'PSBT has no inputs to sign');
        const inputIndexes = psbt.txInputs.map((_, i) => i);

        // The co-signer decodes the action FROM this PSBT, runs policy once, and
        // returns its half for each input; the client combines them into the final
        // key-path signatures. A denial throws SDKPolicyError here, aborting the
        // submit before any broadcast.
        const { signatures } = await coSignerClient.signAll({ psbt: psbtHex, secretKey, inputIndexes });

        // Each 64-byte Schnorr sig over its input's BIP341 sighash IS that witness.
        for (const s of signatures) {
            psbt.updateInput(s.index, { tapKeySig: toBuf(s.signature) });
            psbt.finalizeInput(s.index);
        }
        const maxFeeRate = resolveMaxFeeRate(network, maximumFeeRate);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();
        return { txHex: tx.toHex(), txid: tx.getId(), psbtHex: psbt.toHex() };
    };
}

module.exports = { buildMuSig2Signer };
