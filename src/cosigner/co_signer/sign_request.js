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
 * XChain Platform SDK - Co-Signer Signing Request
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const {
    readRequest, validateInputs, deriveEnvelope, revealCommitTxid, evaluateRequest,
} = require('./request_preparation.js');
const {
    checkTransaction, signInputs, toBytes, taprootKeyPathSighash,
} = require('./request_signing.js');

module.exports = {
    /*
     * Decide and (if approved) partial-sign.
     *
     * ONE request shape (wire collapse, 2026-07-27). The legacy single-input
     * form ({psbt, agentPublicNonce, inputIndex}) and its separate success body
     * are gone: an `inputs` array with one element expresses exactly the same
     * request, and two shapes meant two validation paths that every hardening
     * fix had to be applied to twice. The single-input CONVENIENCE lives in
     * CoSignerClient.sign(), which wraps before the wire and unwraps after it.
     *
     * @param {object} req
     *   psbt         {string} PSBT hex (or a bitcoin.Psbt)
     *   inputs       [{ index, agentPublicNonce }]  one entry per input to co-sign
     *   sighashType  {number} optional; applies to every requested input
     * @returns {object}
     *   { approved:false, reason, detail }
     *   { approved:true, action, signatures:[{ index, publicNonce, sig, msg }] }
     */
    process(req = {}) {
        const request = readRequest(this, req);
        if (request.denial) return request.denial;
        const { psbt, inputs } = request;

        const validated = validateInputs(this, psbt, inputs);
        if (validated.denial) return validated.denial;

        const envelope = deriveEnvelope(this, req, psbt);
        if (envelope.denial) return envelope.denial;
        const { env } = envelope;

        const evaluated = evaluateRequest(this, psbt, env);
        if (evaluated.denial) return evaluated.denial;
        const { decoded, verdict } = evaluated;

        const gateDenial = checkTransaction(this, psbt, inputs, validated.seenIdx, env, req);
        if (gateDenial) return gateDenial;

        const signed = signInputs(this, psbt, inputs, env, req);
        if (signed.denial) return signed.denial;
        const { signatures } = signed;

        // 10. Budget consumed ONCE for the tx, on authorization (a per-input record
        //     would over-count; charging on authorization rather than broadcast is
        //     conservative - an abandoned aggregate has still spent the cap).
        //
        //     An envelope is TWO transactions carrying ONE action, so it is
        //     charged once, at the commit: that is the transaction that spends
        //     account value, and the reveal only spends the commit output the
        //     window already paid for. Charging both would silently halve every
        //     budget for envelope-carried actions while looking correct. A
        //     CANCEL is charged nothing for the same reason and one more: it
        //     returns funds to the account, and making recovery cost budget
        //     would let an agent exhaust its own window by cancelling.
        if (!env || env.role === 'commit') this.recordBudget(psbt, verdict.evaluation);

        return { approved: true, action: decoded.action, signatures,
                 envelopeRole: env ? env.role : undefined };
    },

    // Source gate (G16). `signed` is the set of input indexes this request signs.
    // Input 0 must be among them AND spend this account's script: the prevout gate
    // proves the second for every signed input, so membership is the load-bearing
    // half, and the script re-check keeps this correct if the gates are ever
    // reordered.
    // `expectedScript` mirrors checkPrevouts: an envelope REVEAL or CANCEL has
    // the commit outpoint at input 0 by construction (§3.5 pins it there, and
    // the decoder's recognition depends on it), so the script to expect is the
    // commit's. The gate itself is unchanged in force: input 0 must still be one
    // of the inputs we sign, and must still spend a script this daemon derived
    // rather than one the caller named.
    checkSource(psbt, signed, expectedScript) {
        const expected = expectedScript || this.accountScript;
        if (!signed.has(0))
            return this.deny('SOURCE_NOT_OUR_ACCOUNT',
                { detail: 'input 0 is the action\'s protocol source but is not one of the inputs being co-signed' });
        const inp = psbt.data.inputs[0];
        if (!inp || !inp.witnessUtxo || !inp.witnessUtxo.script)
            return this.deny('SOURCE_NOT_OUR_ACCOUNT', { detail: 'input 0 has no witnessUtxo' });
        if (!inp.witnessUtxo.script.equals(expected))
            return this.deny('SOURCE_NOT_OUR_ACCOUNT', {
                expected: expected.toString('hex'),
                got:      inp.witnessUtxo.script.toString('hex'),
            });
        return null;
    },

    // Record one window entry for the whole tx (single authorization). The txid is
    // fixed pre-signature for segwit/taproot inputs, so it is a stable audit key;
    // best-effort (null if reconstruction fails). No-op without a window store.
    recordBudget(psbt, evaluation) {
        if (!this.windowStore) return;
        let txid = null;
        try {
            const tx = new bitcoin.Transaction();
            tx.version  = psbt.version;
            tx.locktime = psbt.locktime;
            for (const ti of psbt.txInputs)  tx.addInput(ti.hash, ti.index, ti.sequence);
            for (const to of psbt.txOutputs) tx.addOutput(to.script, to.value);
            txid = tx.getId();
        } catch (e) { /* audit txid is best-effort */ }
        this.windowStore.record({
            action: evaluation.action, tick: evaluation.tick, amount: evaluation.amount, txid,
        });
    },
    toBytes,
    taprootKeyPathSighash,
    revealCommitTxid,
};
