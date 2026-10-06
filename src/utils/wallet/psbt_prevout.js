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
 * XChain Platform SDK - PSBT prevout resolution
 *
 * The output a PSBT input spends, read the way bitcoinjs-lib signs it.
 *
 * A PSBT input may carry its prevout twice: as the full previous transaction
 * (nonWitnessUtxo) and as a bare { script, value } (witnessUtxo). bitcoinjs
 * signs and finalizes against the nonWitnessUtxo whenever one is present,
 * after checking its hash against the input's prevout txid, while the
 * witnessUtxo is never checked against anything. A reader that prefers the
 * witnessUtxo can therefore be shown one script and value while the key signs
 * another, which is how a hostile encoder could slip a drain or a fee burn
 * past a reconcile gate. Every SDK reader that judges an input (the reconcile
 * gate, the encoder fee totals, the wallet's confirm view, the signers'
 * pre-sign check) resolves it here instead, and an input whose two fields
 * disagree is refused rather than resolved.
 *
 ********************************************************************/

'use strict';

require('../apply_bufferutils_patch');
const bitcoin = require('bitcoinjs-lib');
const { SDKWalletError } = require('../errors.js');

// Compare two satoshi values that may arrive as Number or BigInt (large DOGE values are BigInt).
function sameSats(a, b) {
    try { return BigInt(a) === BigInt(b); } catch (e) { return false; }
}

// Build the refusal every caller receives, naming the input and what disagreed.
function inconsistent(i, detail) {
    return new SDKWalletError('INCONSISTENT_PREVOUT', 'input ' + i + ': ' + detail, { input: i });
}

/**
 * Resolve one input's prevout from its PSBT data and its unsigned-tx input.
 *
 * @param {object} data  psbt.data.inputs[i]
 * @param {{ hash: Buffer, index: number }} txIn  psbt.txInputs[i]
 * @param {number} i  input index, for the error message
 * @returns {({ script: Buffer, value: (number|bigint) }|null)} null when the
 *   input carries no UTXO data at all
 * @throws {SDKWalletError} INCONSISTENT_PREVOUT when the UTXO data cannot be trusted
 */
function findInputPrevout(data, txIn, i) {
    if (!data || !txIn) return null;
    if (data.nonWitnessUtxo) {
        let prevTx;
        try { prevTx = bitcoin.Transaction.fromBuffer(data.nonWitnessUtxo); }
        catch (e) { throw inconsistent(i, 'nonWitnessUtxo does not parse (' + e.message + ')'); }
        // Verify the full previous transaction is the one this input spends, as bitcoinjs does before signing
        if (!prevTx.getHash().equals(txIn.hash))
            throw inconsistent(i, 'nonWitnessUtxo hash does not match the input prevout txid');
        const out = prevTx.outs[txIn.index];
        // Verify the spent output index exists in that transaction
        if (!out) throw inconsistent(i, 'nonWitnessUtxo has no output ' + txIn.index);
        // Verify a witnessUtxo, when also present, names the same script and value the signature uses
        if (data.witnessUtxo && !(Buffer.from(data.witnessUtxo.script).equals(out.script)
            && sameSats(data.witnessUtxo.value, out.value)))
            throw inconsistent(i, 'witnessUtxo disagrees with the nonWitnessUtxo prevout it claims to describe');
        return { script: out.script, value: out.value };
    }
    if (data.witnessUtxo) return { script: data.witnessUtxo.script, value: data.witnessUtxo.value };
    return null;
}

/**
 * Resolve input i of a parsed PSBT; see findInputPrevout.
 *
 * @param {import('bitcoinjs-lib').Psbt} psbt
 * @param {number} i
 * @returns {({ script: Buffer, value: (number|bigint) }|null)}
 */
function findVerifiedPrevout(psbt, i) {
    return findInputPrevout(psbt.data.inputs[i], psbt.txInputs[i], i);
}

/**
 * Refuse a PSBT in which any input's UTXO fields contradict each other, before
 * anything is signed or a fee is computed from them. Inputs with no UTXO data
 * pass here; bitcoinjs refuses to sign those on its own.
 *
 * @param {import('bitcoinjs-lib').Psbt} psbt
 * @throws {SDKWalletError} INCONSISTENT_PREVOUT
 */
function assertConsistentPrevouts(psbt) {
    for (let i = 0; i < psbt.txInputs.length; i++) findVerifiedPrevout(psbt, i);
}

module.exports = { findInputPrevout, findVerifiedPrevout, assertConsistentPrevouts };
