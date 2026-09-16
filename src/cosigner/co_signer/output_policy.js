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
 * XChain Platform SDK - Co-Signer Policy
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');

// SIGHASH_DEFAULT (0x00) is the only type honored past this gate. SIGHASH_ALL
// (0x01) also commits to ALL outputs and would be equally safe from the output-
// gate's point of view, but the witness-assembly side (musig2_signer.js) writes
// a bare 64-byte tapKeySig with no trailing sighash-flag byte, which BIP341
// only permits for SIGHASH_DEFAULT; a non-default type here would sign
// something the rest of the pipeline cannot correctly finalize. NONE/SINGLE
// and ANYONECANPAY additionally let a caller obtain a partial signature over a
// message that does not bind the outputs the co-signer just gated, then
// reassemble a drain transaction that still verifies on-chain. `undefined`
// defaults to SIGHASH_DEFAULT and is allowed.
// Parse an operator-supplied satoshi bound to an EXACT u64, or null if it cannot be
// represented exactly. Accepts bigint, an integer Number, and a digit string, because
// a config value above 2^53 can only reach us intact as one of the latter two.
// Number() would silently round it, which is the whole defect.
//
// SAFE integer, not merely integer. A Number above 2^53-1 arrives here ALREADY
// rounded, so accepting it would launder a lossy value into a cap this file
// then compares exactly - the same defect one step later. Such a cap must be a
// bigint or a digit string; callers fail closed on the null.
function exactU64(v) {
    if (typeof v === 'bigint') return v >= 0n ? v : null;
    if (typeof v === 'number') return (Number.isSafeInteger(v) && v >= 0) ? BigInt(v) : null;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
}

// The five standard single-recipient payment templates. Anything else - bare
// multisig above all - is refused as an allowedOutputs entry (see
// normalizeAllowedOutputs, G7). Matching is structural, on the decompiled
// script, so it cannot be fooled by an address encoding.
function isStandardPaymentScript(script) {
    if (!Buffer.isBuffer(script)) return false;
    let d;
    try { d = bitcoin.script.decompile(script); } catch (e) { return false; }
    if (!d) return false;
    const op = bitcoin.opcodes;
    // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
    if (d.length === 5 && d[0] === op.OP_DUP && d[1] === op.OP_HASH160 &&
        Buffer.isBuffer(d[2]) && d[2].length === 20 &&
        d[3] === op.OP_EQUALVERIFY && d[4] === op.OP_CHECKSIG) return true;
    // P2SH: OP_HASH160 <20> OP_EQUAL
    if (d.length === 3 && d[0] === op.OP_HASH160 &&
        Buffer.isBuffer(d[1]) && d[1].length === 20 && d[2] === op.OP_EQUAL) return true;
    // P2WPKH / P2WSH: OP_0 <20|32>
    if (d.length === 2 && d[0] === op.OP_0 &&
        Buffer.isBuffer(d[1]) && (d[1].length === 20 || d[1].length === 32)) return true;
    // P2TR: OP_1 <32>
    if (d.length === 2 && d[0] === op.OP_1 &&
        Buffer.isBuffer(d[1]) && d[1].length === 32) return true;
    return false;
}

// (a) OP_RETURN data carrier: carries the action, not value. It MUST
//     carry zero value. An OP_RETURN output is provably unspendable,
//     so any satoshis assigned to it are burned. Exempting it without
//     a value check let a malicious agent assign value = the entire
//     input amount (and omit the change output), burning the whole
//     account balance behind a benign, in-policy action - exactly the
//     drain this gate exists to stop, just via destruction rather than
//     diversion. The value guard also neutralizes a decoy OP_RETURN of
//     a non-carrier shape (which the decoder's strict length===2 count
//     ignores) being used as a value sink.
//
//     ON AN ENVELOPE ROLE THE EXEMPTION DOES NOT APPLY AT ALL. An
//     envelope carries its action in the tapleaf, so the transaction
//     needs no data carrier: the signing flow decodes a COMMIT and a CANCEL
//     from the leaf script, never from this PSBT, and a CANCEL is not
//     policy-judged at all on the premise that it publishes NO ACTION.
//     A zero-value OP_RETURN waved through here is therefore a SECOND
//     action that nothing in this daemon judged, riding on a signature
//     the daemon gave to something else - and the chain reads it, because
//     envelope recognition is witness-based and a commit reveals no
//     envelope witness. The value check is the wrong question for it: the
//     carrier is not a burn, it is an unauthorized command. Refuse it
//     under the same reason string the reveal path already uses for a
//     mixed carrier (psbtActionDecode.extractEnvelopeActionString).
function inspectDataCarrier(coSigner, out, index, env) {
    let decomp = null;
    try { decomp = bitcoin.script.decompile(out.script); } catch (e) { /* non-standard */ }
    if (!decomp || decomp[0] !== bitcoin.opcodes.OP_RETURN) return { handled: false };
    if (env) return { handled: true, denial: coSigner.deny('ENVELOPE_MIXED_CARRIER', { index }) };
    if (Number(out.value) > 0)
        return { handled: true, denial: coSigner.deny('OP_RETURN_CARRIES_VALUE', { index, value: out.value }) };
    return { handled: true, denial: null };
}

// (b2) The envelope commit output on a COMMIT request. Its value is
//      the reveal's prefunded miner fee plus one dust change, so it
//      leaves the account for good and is bounded by maxFeeSats:
//      without that cap an "envelope" is an unbounded drain wearing
//      a commit output's shape. Exactly one is authorized; a second
//      would be a second, ungated envelope on the same transaction.
function checkEnvelopeCommitOutput(coSigner, out, index, commitOutputsSeen) {
    if (commitOutputsSeen > 0)
        return coSigner.deny('UNAUTHORIZED_OUTPUT', { index, detail: 'more than one envelope commit output' });
    if (coSigner.maxFeeSats === null)
        return coSigner.deny('ENVELOPE_COMMIT_UNBOUNDED',
            'an envelope commit prefunds the reveal fee, so maxFeeSats must be set to bound it');
    // Same exact-u64 comparison as the allowed-output caps below:
    // a value Number() cannot hold exactly must not be compared as a Number.
    const commitValue = coSigner.toU64(out.value);
    if (commitValue === null || commitValue > coSigner.maxFeeSats)
        return coSigner.deny('OUTPUT_OVER_CAP',
            { index, value: String(out.value), maxValue: String(coSigner.maxFeeSats), detail: 'envelope commit output' });
    return null;
}

// (c) An operator-authorized native leg (COINPAY recipient / fee output).
function checkAllowedOutput(coSigner, out, index, match, spent) {
    // Exact u64 arithmetic end to end: a value this policy
    // cannot represent exactly is refused rather than rounded into the cap.
    const value = coSigner.toU64(out.value);
    if (value === null)
        return coSigner.deny('OUTPUT_OVER_CAP',
            { index, value: String(out.value), maxValue: String(match.maxValue), detail: 'output value is not an exact non-negative integer' });
    const total = (spent.get(match) || 0n) + value;
    spent.set(match, total);
    // maxValue is mandatory since G7, so this is always a real bound.
    if (total > match.maxValue)
        return coSigner.deny('OUTPUT_OVER_CAP', { index, value: String(out.value), total: String(total), maxValue: String(match.maxValue) });
    return null;
}

module.exports = {
    // Normalize the allow-list once at construction (throws on bad config, never at
    // sign time). Each entry: { address | script, maxValue? }.
    normalizeAllowedOutputs(list) {
        if (!Array.isArray(list)) throw new Error('allowedOutputs must be an array');
        return list.map((o, i) => {
            let script;
            if (o.script) {
                script = Buffer.isBuffer(o.script) ? o.script : Buffer.from(o.script, 'hex');
            } else if (o.address) {
                try { script = bitcoin.address.toOutputScript(o.address, this.network || undefined); }
                catch (e) { throw new Error(`allowedOutputs[${i}]: invalid address (${e.message})`); }
            } else {
                throw new Error(`allowedOutputs[${i}] needs an address or script`);
            }
            // G7: entries MUST be standard single-recipient payment scripts. This
            // gate is not only about tidiness - it is the only thing standing
            // between the co-signer and ALTERNATE-CARRIER ACTION SMUGGLING. The
            // authoritative decoder recognizes carrier shapes decodeActionFromPsbt
            // never examines (bare 1-of-3 multisig, the P2SH/P2WSH two-phase
            // reveal), so a transaction could carry a benign OP_RETURN action for
            // the co-signer to approve and a DIFFERENT action in a second carrier
            // for the chain to execute. Today that is impossible only because such
            // a carrier is an output that is neither the OP_RETURN, nor change, nor
            // allow-listed. Letting an operator allow-list a bare-multisig or
            // otherwise non-standard script would hand that property away, and the
            // anti-smuggling role is nowhere near obvious from the anti-drain code.
            if (!isStandardPaymentScript(script))
                throw new Error(`allowedOutputs[${i}] is not a standard single-recipient payment script ` +
                    `(P2PKH, P2SH, P2WPKH, P2WSH or P2TR). Non-standard scripts - notably bare multisig - ` +
                    `are also ALTERNATE ACTION CARRIERS the authoritative decoder reads but the co-signer ` +
                    `does not, so allow-listing one would let a second, ungated action ride the same ` +
                    `transaction.`);
            // G7: an entry with no maxValue authorizes UNLIMITED per-tx value to
            // that address, which is not a bound at all. Even with one, the
            // cumulative ceiling across transactions is maxActions * maxValue (G12).
            if (o.maxValue === undefined || o.maxValue === null)
                throw new Error(`allowedOutputs[${i}] needs a maxValue: without one the entry authorizes ` +
                    `unlimited native coin to that address on every approved transaction`);
            // BigInt, not Number: satoshi caps are u64, and Number(9007199254740993n)
            // is 9007199254740992, so an output ONE unit above a >2^53 cap compared
            // equal and was approved. The rest of this file already reconciles fees
            // in BigInt for the same reason (see toU64).
            const maxValue = exactU64(o.maxValue);
            if (maxValue === null)
                throw new Error(`allowedOutputs[${i}].maxValue must be a non-negative integer (number, bigint, or digit string)`);
            return { script, maxValue };
        });
    },

    // Anti-drain gate: the co-signer key-path-signs a spend of the aggregate
    // account, so the tx OUTPUTS decide where the native coin goes - and the action
    // string (the only thing decoded) does NOT constrain them. Without this, a WIF
    // holder could show a benign in-policy action yet add an output draining the
    // account's coin to themselves. Permit only: the OP_RETURN data carrier, change
    // back to the account we spend from, and operator-authorized outputs. Anything
    // else fails closed. Returns a denial object, or null when every output is safe.
    // `env` is the envelope context when this request is part of an envelope
    // (null otherwise). It changes exactly two things: on a COMMIT the single
    // commit output is authorized (it is the only way to fund an envelope at
    // all), and on a REVEAL/CANCEL "change back to self" means the ACCOUNT
    // script rather than the input's own script, which is the one-shot commit
    // output and must never be treated as a safe place to return value to.
    checkOutputs(psbt, idx, env) {
        const inp = psbt.data.inputs[idx];
        if (!inp || !inp.witnessUtxo || !inp.witnessUtxo.script)
            return this.deny('CANNOT_CHECK_OUTPUTS', 'signed input has no witnessUtxo');
        const accountScript = env ? this.accountScript : inp.witnessUtxo.script;
        // Running total PER allow-list entry, so N outputs matching the SAME
        // entry are capped on their sum, not each independently (otherwise a
        // repeated authorized output multiplies the operator's cap by N).
        // Keyed on the entry object itself (not the script bytes) so two
        // distinct entries never share a budget even if they somehow matched
        // the same script.
        const spent = new Map();
        let commitOutputsSeen = 0;
        for (let i = 0; i < psbt.txOutputs.length; i++) {
            const out = psbt.txOutputs[i];
            const carrier = inspectDataCarrier(this, out, i, env);
            if (carrier.handled) {
                if (carrier.denial) return carrier.denial;
                continue;
            }
            // (b) Change back to the account we spend from stays under co-signer control.
            if (out.script.equals(accountScript)) continue;
            if (env && env.role === 'commit' && out.script.equals(env.commit.output)) {
                const denial = checkEnvelopeCommitOutput(this, out, i, commitOutputsSeen++);
                if (denial) return denial;
                continue;
            }
            const match = this.allowedOutputs.find((a) => out.script.equals(a.script));
            if (match) {
                const denial = checkAllowedOutput(this, out, i, match, spent);
                if (denial) return denial;
                continue;
            }
            // Anything else is an unauthorized native-coin drain.
            return this.deny('UNAUTHORIZED_OUTPUT', { index: i, value: out.value });
        }
        return null;
    },

    // Anti-burn gate: checkOutputs blocks value DIVERSION, but the action string
    // never constrains the miner FEE, so a malicious agent can still burn the whole
    // account by omitting (or undersizing) the change output, leaving the entire
    // remainder = sum(inputs) - sum(outputs) to miners behind a benign in-policy
    // action. setMaximumFeeRate (musig2_signer.js/wallet.js) runs only on the
    // attacker-controlled client, so the daemon reconciles the fee itself here from
    // data it already holds: every input's witnessUtxo.value (mandatory for the
    // sighash). Always-on, false-positive-free guards: fee uncomputable (an input
    // has no witnessUtxo value), a value-negative (unrelayable) tx, and the
    // canonical full burn where every satoshi becomes fee because no output
    // returns any value (totalOut === 0). A tighter bound (e.g. catching an
    // undersized dust-change drain, which is indistinguishable from a legitimate
    // high fee without chain knowledge) needs the operator's maxFeeSats cap.
    // Returns a denial object, or null when the fee is within bounds.
    // Values arrive as Number OR BigInt: apply_bufferutils_patch.js teaches
    // bip174/bitcoinjs to carry satoshi values above 2^53-1 (e.g. large DOGE
    // UTXOs) as BigInt (see narrowU64). The arithmetic below is done entirely
    // in BigInt so a >2^53 value is neither rejected outright nor rounded.
    toU64(v) {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
        return null;
    },

    checkFee(psbt) {
        let totalIn = 0n;
        for (let i = 0; i < psbt.txInputs.length; i++) {
            const wu = psbt.data.inputs[i] && psbt.data.inputs[i].witnessUtxo;
            const v = wu ? this.toU64(wu.value) : null;
            if (v === null)
                return this.deny('CANNOT_CHECK_FEE', 'input ' + i + ' has no witnessUtxo value');
            totalIn += v;
        }
        let totalOut = 0n;
        for (const out of psbt.txOutputs) {
            const v = this.toU64(out.value);
            if (v === null)
                return this.deny('CANNOT_CHECK_FEE', 'non-numeric or non-integral output value');
            totalOut += v;
        }
        const fee = totalIn - totalOut;
        if (fee < 0n)
            return this.deny('OUTPUTS_EXCEED_INPUTS', { totalIn: totalIn.toString(), totalOut: totalOut.toString() });
        if (totalIn > 0n && totalOut === 0n)
            return this.deny('FEE_BURNS_ENTIRE_INPUT', { totalIn: totalIn.toString(), fee: fee.toString() });
        if (this.maxFeeSats !== null && fee > this.maxFeeSats)
            return this.deny('FEE_EXCEEDS_CAP', { fee: fee.toString(), maxFeeSats: String(this.maxFeeSats) });
        return null;
    },

    // Anti-forgery gate: checkOutputs/checkFee both trust the caller-supplied
    // witnessUtxo.script/value as ground truth for the account being spent, but
    // never verify it actually IS this daemon's account before recordBudget
    // permanently consumes velocity-window budget. A caller could hand a
    // witnessUtxo pointing at a foreign/attacker-chosen script, sail through
    // the output/fee gates (which only ever compare against that same
    // caller-supplied script), and drain budget with no real spend of the
    // daemon's own account. Verify every witnessUtxo.script in `indices`
    // against the daemon-derived this.accountScript BEFORE any budget is
    // recorded. Keeps the existing CANNOT_CHECK_OUTPUTS denial for a missing
    // witnessUtxo entirely. Returns a denial object, or null when every
    // checked input's prevout is confirmed to be this account.
    // `expectedScript` defaults to this account's script. An envelope reveal or
    // cancel spends the COMMIT output instead, which is not the account script
    // but is derived by this daemon from the account's own aggregate key plus a
    // leaf it has parsed and read the action out of, so it is equally proven to
    // belong to this account. Passing it explicitly keeps the gate a real check
    // in both cases rather than something the envelope path skips.
    checkPrevouts(psbt, indices, expectedScript) {
        const expected = expectedScript || this.accountScript;
        for (const idx of indices) {
            const inp = psbt.data.inputs[idx];
            if (!inp || !inp.witnessUtxo || !inp.witnessUtxo.script)
                return this.deny('CANNOT_CHECK_OUTPUTS', 'signed input has no witnessUtxo');
            const got = inp.witnessUtxo.script;
            if (!got.equals(expected))
                return this.deny('PREVOUT_NOT_OUR_ACCOUNT', {
                    index:    idx,
                    expected: expected.toString('hex'),
                    got:      got.toString('hex'),
                });
        }
        return null;
    },
    exactU64,
    isStandardPaymentScript,
};
