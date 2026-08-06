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
 *********************************************************************/

'use strict';

/*
 * Reconcile an encoder-authored PSBT against the intent that was submitted, at the
 * last moment before a signature exists.
 *
 * The encoder is a REMOTE service (encoder.createTx / spendP2sh are RPC calls). It
 * chooses the inputs, the outputs and the miner fee, and until this gate existed
 * nothing between that response and wallet.signPsbt asked whether what came back
 * still matched what was asked for. A compromised or misconfigured encoder could
 * therefore point wallet-owned value at an output of its choosing, or burn the whole
 * balance as fee, behind an action string that reads as benign.
 *
 * The daemon co-signer already reconciles its own side (coSigner.js _checkOutputs /
 * _checkFee); this is the same discipline for the single-WIF path, which has no
 * daemon in it. Rules are chosen to be false-positive-free: every authorization is
 * read out of the PSBT itself or out of the caller's own submitted intent, never
 * guessed from the encoder's answer.
 *
 * Fail-closed: throws SDKActionError on the first output or fee it cannot account
 * for. Returns { fee, totalIn, totalOut } (fee null when the PSBT does not carry
 * enough input data to compute one).
 */

const bitcoin = require('bitcoinjs-lib');
const { SDKActionError } = require('./errors.js');

// Satoshi values arrive as Number OR BigInt: applyBufferutilsPatch teaches
// bip174/bitcoinjs to carry values above 2^53-1 (large DOGE UTXOs) as BigInt.
// All arithmetic here is BigInt so a >2^53 value is neither rejected nor rounded.
function toU64(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
    return null;
}

// The output script an input spends, from whichever UTXO form the PSBT carries.
// bitcoinjs needs one of the two to sign at all, so an input with neither cannot
// be signed and the fail-closed path below is not a false positive.
function inputScript(psbt, i) {
    const data = psbt.data.inputs[i];
    if (!data) return null;
    if (data.witnessUtxo && data.witnessUtxo.script) return data.witnessUtxo.script;
    if (data.nonWitnessUtxo) {
        try {
            const prev = bitcoin.Transaction.fromBuffer(data.nonWitnessUtxo);
            const vout = psbt.txInputs[i].index;
            const out = prev.outs[vout];
            return out ? out.script : null;
        } catch (e) { return null; }
    }
    return null;
}

// The value an input brings in, same two forms.
function inputValue(psbt, i) {
    const data = psbt.data.inputs[i];
    if (!data) return null;
    if (data.witnessUtxo) return toU64(data.witnessUtxo.value);
    if (data.nonWitnessUtxo) {
        try {
            const prev = bitcoin.Transaction.fromBuffer(data.nonWitnessUtxo);
            const out = prev.outs[psbt.txInputs[i].index];
            return out ? toU64(out.value) : null;
        } catch (e) { return null; }
    }
    return null;
}

function isOpReturn(script) {
    try {
        const decompiled = bitcoin.script.decompile(script);
        return !!(decompiled && decompiled[0] === bitcoin.opcodes.OP_RETURN);
    } catch (e) { return false; }
}

// The script SHAPES a two-phase or envelope funding leg is allowed to take. These
// legs pay an encoder-derived script the SDK cannot predict (the P2SH/P2WSH data
// chunks, the one-shot envelope commit), and a chunked P2SH action emits as many of
// them as the payload needs, so they cannot be pinned by address or by count. What
// they can be pinned to is shape: a plain payment to an arbitrary P2PKH/P2WPKH
// recipient - the drain this gate exists to stop - is not one of these.
const PHASE_SHAPES = {
    // OP_HASH160 <20> OP_EQUAL
    p2sh:  (d) => d.length === 3 && d[0] === bitcoin.opcodes.OP_HASH160 && Buffer.isBuffer(d[1]) && d[1].length === 20 && d[2] === bitcoin.opcodes.OP_EQUAL,
    // OP_0 <32>
    p2wsh: (d) => d.length === 2 && d[0] === bitcoin.opcodes.OP_0 && Buffer.isBuffer(d[1]) && d[1].length === 32,
    // OP_1 <32>
    p2tr:  (d) => d.length === 2 && d[0] === bitcoin.opcodes.OP_1 && Buffer.isBuffer(d[1]) && d[1].length === 32,
};

function matchesPhaseShape(script, shapes) {
    if (!shapes || !shapes.length) return false;
    let decompiled = null;
    try { decompiled = bitcoin.script.decompile(script); } catch (e) { return false; }
    if (!decompiled) return false;
    return shapes.some((name) => PHASE_SHAPES[name] && PHASE_SHAPES[name](decompiled));
}

// Resolve a submitted customOutput address to its script. An address the local
// network cannot parse authorizes nothing (it is not silently trusted): the output
// it was meant to authorize then falls through to UNRECONCILED_OUTPUT.
function scriptForAddress(address, network) {
    try { return bitcoin.address.toOutputScript(String(address), network || undefined); }
    catch (e) { return null; }
}

/*
 * @param {string} psbtHex          the encoder's answer, unsigned
 * @param {object} intent
 *   network        {object}   bitcoinjs network, for parsing submitted addresses
 *   customOutputs  {Array}    [{ address, value }] exactly as submitted, or null
 *   maxFeeSats     {number}   absolute fee ceiling from the caller, or null
 *   phaseShapes    {string[]} script shapes this phase's encoder-derived funding
 *                             legs may take ('p2sh' / 'p2wsh' / 'p2tr'), empty or
 *                             absent for a plain single-phase action
 *   label          {string}   which PSBT this is, for the error message
 */
function reconcileEncoded(psbtHex, intent) {
    intent = intent || {};
    const label = intent.label || 'transaction';
    const deny = (code, detail) => {
        throw new SDKActionError(code,
            'encoder-authored ' + label + ' does not reconcile against the submitted intent: '
            + (typeof detail === 'string' ? detail : JSON.stringify(detail)),
            { psbtHex, detail });
    };

    let psbt;
    try { psbt = bitcoin.Psbt.fromHex(psbtHex); }
    catch (e) { return deny('UNRECONCILABLE_PSBT', 'the encoder response is not a decodable PSBT: ' + (e && e.message)); }

    // Funding scripts: change returning to a script we are already spending FROM
    // stays under the signer's control, whichever address scheme the encoder chose.
    // Reading them out of the PSBT is what makes this rule false-positive-free -
    // the SDK cannot predict the change script otherwise, since `pubkey` may be a
    // raw key and the encoder picks the scheme.
    const fundingScripts = [];
    let totalIn = 0n;
    let feeComputable = true;
    for (let i = 0; i < psbt.txInputs.length; i++) {
        const script = inputScript(psbt, i);
        if (!script) return deny('UNRECONCILABLE_PSBT', 'input ' + i + ' carries no witnessUtxo or nonWitnessUtxo, so its funding script cannot be established');
        fundingScripts.push(script);
        const value = inputValue(psbt, i);
        if (value === null) feeComputable = false; else totalIn += value;
    }
    if (!fundingScripts.length) return deny('UNRECONCILABLE_PSBT', 'the encoder returned a transaction with no inputs');

    // Submitted customOutputs, summed per address: N outputs to the same authorized
    // address are capped on their total, or a repeated output multiplies the cap.
    const authorized = [];
    for (const out of (Array.isArray(intent.customOutputs) ? intent.customOutputs : [])) {
        if (!out || out.address == null) continue;
        const script = scriptForAddress(out.address, intent.network);
        if (!script) continue;
        const value = toU64(Number(out.value));
        const existing = authorized.find((a) => a.script.equals(script));
        if (existing) existing.maxValue += (value === null ? 0n : value);
        else authorized.push({ script, maxValue: (value === null ? 0n : value), spent: 0n });
    }

    let totalOut = 0n;
    const phaseShapes = Array.isArray(intent.phaseShapes) ? intent.phaseShapes : [];
    for (let i = 0; i < psbt.txOutputs.length; i++) {
        const out = psbt.txOutputs[i];
        const value = toU64(out.value);
        if (value === null) return deny('UNRECONCILABLE_PSBT', 'output ' + i + ' has a non-integer value');
        totalOut += value;

        // (a) The OP_RETURN data carrier holds the action, not value. It is provably
        //     unspendable, so any satoshis on it are burned - a drain by destruction
        //     rather than diversion, which the value guard closes.
        if (isOpReturn(out.script)) {
            if (value > 0n) return deny('OP_RETURN_CARRIES_VALUE', { index: i, value: String(value) });
            continue;
        }
        // (b) Change back to a script we are spending from.
        if (fundingScripts.some((s) => out.script.equals(s))) continue;
        // (c) An output the caller itself asked for, capped at what it asked for.
        const match = authorized.find((a) => a.script.equals(out.script));
        if (match) {
            match.spent += value;
            if (match.spent > match.maxValue)
                return deny('OUTPUT_OVER_REQUESTED_VALUE',
                    { index: i, value: String(value), total: String(match.spent), requested: String(match.maxValue) });
            continue;
        }
        // (d) An encoder-derived funding leg for this phase. Authorized by shape,
        //     since the script is the encoder's to derive and a chunked payload
        //     emits as many of them as it needs. Residual, deliberately stated: a
        //     hostile encoder can still park value in a script of the right shape,
        //     bounded by maxFeeSats when the caller sets one.
        if (matchesPhaseShape(out.script, phaseShapes)) continue;
        // Anything else is value leaving for a destination nobody asked for.
        return deny('UNRECONCILED_OUTPUT', { index: i, value: String(value), script: out.script.toString('hex') });
    }

    if (!feeComputable) return { fee: null, totalIn: null, totalOut };

    // (e) Fee. The action string never constrains the miner fee, so an encoder can
    //     drain the balance by omitting or undersizing change and leaving the
    //     remainder to miners. Two always-on guards that cannot false-positive: a
    //     value-negative (unrelayable) transaction, and the canonical full burn
    //     where nothing comes back at all. A tighter bound needs the caller's cap,
    //     because an undersized change output is indistinguishable from a
    //     legitimately high fee without chain knowledge.
    if (totalOut > totalIn)
        return deny('NEGATIVE_FEE', { totalIn: String(totalIn), totalOut: String(totalOut) });
    if (totalIn > 0n && totalOut === 0n)
        return deny('FULL_BURN_FEE', { totalIn: String(totalIn), detail: 'every satoshi would go to miners' });
    const fee = totalIn - totalOut;
    const maxFee = toU64(Number(intent.maxFeeSats));
    if (intent.maxFeeSats != null && maxFee !== null && fee > maxFee)
        return deny('FEE_OVER_CAP', { fee: String(fee), maxFeeSats: String(maxFee) });

    return { fee, totalIn, totalOut };
}

module.exports = { reconcileEncoded };
