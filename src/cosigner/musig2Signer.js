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
 * via submitOpts.signer (see lifecycleManager.js).
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
const { SDKPolicyError } = require('../errors.js');

// Taproot finalize/extract needs an ECC backend; idempotent, safe on load.
bitcoin.initEccLib(ecc);

function toBuf(v) { return Buffer.isBuffer(v) ? v : Buffer.from(v); }

/*
 * @param {object} config
 *   coSignerClient {CoSignerClient}  the agent-side round runner
 *   secretKey      {Uint8Array|hex}  the agent's 32-byte key (its MuSig2 half)
 *   network        {object}          bitcoinjs network for PSBT parsing (optional)
 * @returns {function} async (psbtHex) -> { txHex, txid, psbtHex }
 */
function buildMuSig2Signer(config = {}) {
    const { coSignerClient, secretKey, network } = config;
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
        const tx = psbt.extractTransaction();
        return { txHex: tx.toHex(), txid: tx.getId(), psbtHex: psbt.toHex() };
    };
}

module.exports = { buildMuSig2Signer };
