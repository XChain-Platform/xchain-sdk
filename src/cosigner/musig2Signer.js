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
 * SCOPE (P3 slice 2): a single taproot input under the aggregate account
 * (the common freshly-funded / consolidated agent wallet). A multi-input
 * tx needs a distinct MuSig2 nonce + round PER input AND single-shot budget
 * accounting on the daemon - a naive per-input loop both reuses nonces and
 * double-charges the policy window (the second input sees the first already
 * recorded). Until that lands we FAIL CLOSED on > 1 input rather than
 * mis-sign or over-count.
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
        if (psbt.txInputs.length !== 1)
            throw new SDKPolicyError('MUSIG2_MULTI_INPUT_UNSUPPORTED',
                `MuSig2 submit supports a single input this slice; got ${psbt.txInputs.length}. ` +
                'Consolidate the aggregate account to one UTXO (multi-input is a later slice).');

        // The co-signer decodes the action FROM this PSBT, runs policy, and returns
        // its half; the client combines into the final key-path signature. A denial
        // throws SDKPolicyError here, aborting the submit before any broadcast.
        const { signature } = await coSignerClient.sign({ psbt: psbtHex, secretKey, inputIndex: 0 });

        // The 64-byte Schnorr sig over the BIP341 key-path sighash IS the witness.
        psbt.updateInput(0, { tapKeySig: toBuf(signature) });
        psbt.finalizeInput(0);
        const tx = psbt.extractTransaction();
        return { txHex: tx.toHex(), txid: tx.getId(), psbtHex: psbt.toHex() };
    };
}

module.exports = { buildMuSig2Signer };
