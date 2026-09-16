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
 * XChain Platform SDK - Co-Signer Request Signing
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const { sighashAllowed, disallowedSighashError } = require('../policy/sighash_policy.js');
const { envelopeScriptPathSighash, envelopeRoundTweaks } = require('../envelope.js');

function toBytes(v, label) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return Buffer.from(v, 'hex');
    throw new Error(label + ' must be a hex string or Uint8Array');
}

// BIP341 key-path sighash for one input, reconstructed from the PSBT. Requires a
// witnessUtxo on EVERY input (the sighash commits to all prevouts); throws if any
// is missing, so the caller fails closed rather than signing a half-known tx.
function taprootKeyPathSighash(psbt, inputIndex, hashType) {
    // Defense in depth: never derive a signing message under a sighash type that
    // does not commit to every output. The process() sighash guard rejects it
    // earlier with a clearer code; this also protects any other caller of this export.
    if (!sighashAllowed(hashType)) throw disallowedSighashError(hashType);
    const ins = psbt.txInputs;
    if (inputIndex < 0 || inputIndex >= ins.length)
        throw new Error('inputIndex ' + inputIndex + ' out of range');
    const scripts = [], values = [];
    for (let i = 0; i < ins.length; i++) {
        const wu = psbt.data.inputs[i] && psbt.data.inputs[i].witnessUtxo;
        if (!wu || !wu.script) throw new Error('missing witnessUtxo for input ' + i);
        scripts.push(wu.script);
        values.push(wu.value);
    }
    const tx = new bitcoin.Transaction();
    tx.version  = psbt.version;
    tx.locktime = psbt.locktime;
    for (const ti of psbt.txInputs)  tx.addInput(ti.hash, ti.index, ti.sequence);
    for (const to of psbt.txOutputs) tx.addOutput(to.script, to.value);
    return tx.hashForWitnessV1(inputIndex, scripts, values,
        hashType === undefined ? bitcoin.Transaction.SIGHASH_DEFAULT : hashType);
}

// Run transaction-wide gates before generating any partial signature.
function checkTransaction(self, psbt, inputs, seenIdx, env, req) {
    // 5. Prevout gate: verify every input we are about to sign for actually
    //    spends THIS account's derived scriptPubKey, not a caller-supplied
    //    witnessUtxo pointing at a foreign script. Must run before any budget
    //    consumption below.
    const prevoutDenial = self.checkPrevouts(psbt, inputs.map((it) => it.index),
        env && env.role !== 'commit' ? env.commit.output : null);
    if (prevoutDenial) return prevoutDenial;

    // 5b. Source gate (G16): the action's protocol SOURCE is the transaction's
    //     first input - it is the address the chain attributes the action to,
    //     and the txid that keys the OP_RETURN obfuscation. Nothing else here
    //     requires input 0 to be an input we sign, so an agent could put a
    //     foreign input at index 0 and this account's UTXO at index 1: the
    //     daemon would decode, policy-check and permanently charge ITS window
    //     for an action the chain credits to a different address, and the
    //     window (which doubles as the approval audit log) would record spends
    //     this account never made. Require input 0 to be one of ours.
    const sourceDenial = self.checkSource(psbt, seenIdx,
        env && env.role !== 'commit' ? env.commit.output : null);
    if (sourceDenial) return sourceDenial;

    // 6. Output gate: the action string does not constrain where the native coin
    //    goes, so refuse any output that is not the data carrier, change-to-self,
    //    or operator-authorized. Blocks a benign-action / drain-output craft.
    //    Once, since all signed inputs share accountScript by the check above.
    const outDenial = self.checkOutputs(psbt, inputs[0].index, env);
    if (outDenial) return outDenial;

    // 7. Fee gate: the output gate stops diversion but not a change-omission
    //    burn that hands the whole account balance to miners as fee.
    const feeDenial = self.checkFee(psbt);
    if (feeDenial) return feeDenial;

    // 8. Reject any sighash type that does not commit to every output. A
    //    NONE/SINGLE/ANYONECANPAY partial would let the agent reassemble a
    //    drain tx that still verifies, bypassing the output gate above.
    if (!sighashAllowed(req.sighashType))
        return self.deny('SIGHASH_TYPE_NOT_ALLOWED', { sighashType: req.sighashType });
    return null;
}

// Generate one deterministic partial signature for each validated input.
function signInputs(self, psbt, inputs, env, req) {
    // 9. One partial signature per input, each over its OWN BIP341 sighash
    //    derived from the PSBT, with that input's own agent nonce (never a
    //    reused nonce).
    //    Three message/tweak shapes now exist, all derived here:
    //      - ordinary spend, and an envelope COMMIT: key-path sighash under
    //        this account's own tweaks (empty for the 2-of-2);
    //      - envelope REVEAL: the BIP342 tapleaf sighash, signed under the
    //        BARE aggregate, because the leaf's OP_CHECKSIG key IS the
    //        aggregate (no tweak);
    //      - envelope CANCEL: the ordinary key-path sighash, but signed
    //        under TapTweak(aggregate || leafHash), because the commit
    //        output key commits to the leaf. That tweak is DERIVED from the
    //        script above, never accepted from the caller (G3).
    //    The three shapes are selected EXPLICITLY rather than by falling
    //    through to this.tweaks: a reveal signs the leaf's bare aggregate, so
    //    on a 2-of-3 (where this.tweaks is the account's key-path tweak) the
    //    fall-through produced a signature under the wrong key.
    const signatures = [];
    const envTweaks = envelopeRoundTweaks(env, self.tweaks);
    for (const it of inputs) {
        let msg;
        try {
            msg = (env && env.role === 'reveal')
                ? envelopeScriptPathSighash(psbt, it.index, req.sighashType, env.commit.leafHash)
                : taprootKeyPathSighash(psbt, it.index, req.sighashType);
        }
        catch (e) { return { denial: self.deny('CANNOT_DERIVE_SIGHASH', e.message) }; }
        let det;
        try {
            det = self.musig.deterministicSign({
                secretKey:         self.secretKey,
                otherPublicNonces: [toBytes(it.agentPublicNonce, 'agentPublicNonce')],
                publicKeys:        self.publicKeys,
                tweaks:            envTweaks,
                msg,
            });
        } catch (e) { return { denial: self.deny('SIGN_FAILED', e.message) }; }
        signatures.push({
            index:       it.index,
            publicNonce: Buffer.from(det.publicNonce).toString('hex'),
            sig:         Buffer.from(det.sig).toString('hex'),
            msg:         Buffer.from(msg).toString('hex'),
        });
    }
    return { signatures };
}

module.exports = { checkTransaction, signInputs, toBytes, taprootKeyPathSighash };
