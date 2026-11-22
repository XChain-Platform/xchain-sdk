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
 * XChain Platform SDK - fee ceiling for a partially signed PSBT
 *
 * A scoped sign that leaves another party's inputs unfinalized never reaches
 * extractTransaction, so bitcoinjs-lib's fee-rate guard never runs, yet the
 * released SIGHASH_ALL signatures let that party complete and broadcast the
 * transaction. This applies the same ceiling before the partial PSBT leaves.
 *
 * On the default ceiling the fee counts every input value the PSBT carries and
 * treats an input with no UTXO data as worth nothing. That is the fee the
 * signer can establish: a foreign input's value is not covered by this key's
 * signature, so a missing or understated one only moves the counterparty's
 * own funds into the fee, while a refusal on its absence would block honest
 * co-signs and stop no one. A caller that names its own maximumFeeRate asks
 * for a bound on the whole transaction, so there an input with no UTXO data
 * is refused as FEE_UNVERIFIABLE rather than counted as zero.
 * The size counts only the scripts already finalized, never more than the
 * final transaction's real size, so the rate errs toward refusing.
 *
 ********************************************************************/

'use strict';

require('../apply_bufferutils_patch');
const bitcoin = require('bitcoinjs-lib');
const { SDKWalletError } = require('../errors.js');
const { findVerifiedPrevout } = require('./psbt_prevout.js');

// bitcoinjs-lib's DEFAULT_OPTS.maximumFeeRate (sat/vB), applied where resolveMaxFeeRate keeps that default.
const BITCOINJS_DEFAULT_MAX_FEE_RATE = 5000;

/**
 * Lower bound on the final virtual size: the unsigned transaction plus the
 * scriptSig and witness of every input already finalized.
 *
 * @param {import('bitcoinjs-lib').Psbt} psbt
 * @returns {number} vbytes
 */
function finalizedVsizeFloor(psbt) {
    const tx = new bitcoin.Transaction();
    tx.version = psbt.version;
    tx.locktime = psbt.locktime;
    let witnessBytes = 0;
    let bareInputs = 0;
    psbt.txInputs.forEach((txIn, i) => {
        const data = psbt.data.inputs[i] || {};
        tx.addInput(txIn.hash, txIn.index, txIn.sequence, data.finalScriptSig);
        if (data.finalScriptWitness) witnessBytes += data.finalScriptWitness.length;
        else bareInputs += 1;
    });
    psbt.txOutputs.forEach((out) => tx.addOutput(out.script, out.value));
    // A witness transaction adds the marker and flag bytes plus one empty-stack byte per input without a witness
    if (witnessBytes > 0) witnessBytes += 2 + bareInputs;
    return Math.ceil((tx.byteLength(false) * 4 + witnessBytes) / 4);
}

/**
 * Refuse a partially signed PSBT whose fee rate reaches the ceiling, using
 * the comparison bitcoinjs-lib's checkFees makes on a full extraction.
 *
 * @param {import('bitcoinjs-lib').Psbt} psbt
 * @param {number|null} maxFeeRate  sat/vB from resolveMaxFeeRate; null keeps bitcoinjs's default
 * @param {{ maximumFeeRate?: number }} [opts]  the signer's opts, to tell an explicit ceiling apart
 * @throws {SDKWalletError} FEE_RATE_TOO_HIGH, or FEE_UNVERIFIABLE under an explicit ceiling
 */
function assertPartialFeeWithinCeiling(psbt, maxFeeRate, opts) {
    const ceiling = maxFeeRate || BITCOINJS_DEFAULT_MAX_FEE_RATE;
    const explicit = !!(opts && Number.isFinite(opts.maximumFeeRate) && opts.maximumFeeRate > 0);
    let fee = 0n;
    for (let i = 0; i < psbt.txInputs.length; i++) {
        const prevout = findVerifiedPrevout(psbt, i);
        if (prevout) fee += BigInt(prevout.value);
        else if (explicit) throw new SDKWalletError('FEE_UNVERIFIABLE',
            `Partial PSBT input ${i} carries no UTXO data, so the ${ceiling} sat/vB ceiling cannot be checked`);
    }
    for (const out of psbt.txOutputs) fee -= BigInt(out.value);
    if (fee <= 0n) return;
    const vsize = finalizedVsizeFloor(psbt);
    const feeRate = Math.floor(Number(fee) / vsize);
    if (feeRate >= ceiling) {
        throw new SDKWalletError('FEE_RATE_TOO_HIGH',
            `Partial PSBT fee ${fee} sat over a ${vsize} vB size floor is ${feeRate} sat/vB, ` +
            `at or above the ${ceiling} sat/vB ceiling`);
    }
}

module.exports = { assertPartialFeeWithinCeiling, finalizedVsizeFloor, BITCOINJS_DEFAULT_MAX_FEE_RATE };
