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
const { evaluatePolicy } = require('../policy_evaluator.js');
const { decodeActionFromPsbt, decodeEnvelopeAction } = require('../psbt_action_decode.js');
const { sighashAllowed, disallowedSighashError } = require('../sighash_policy.js');
const {
    deriveEnvelopeCommit, classifyEnvelopeRole, envelopeScriptPathSighash,
    envelopeRoundTweaks,
} = require('../envelope.js');

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

// The txid of the COMMIT a reveal spends, or null. §3.5 pins the commit outpoint
// at input 0 (the decoder's recognition depends on it, and _checkPrevouts and
// _checkSource both rely on the same placement), so the commit txid is input 0's
// prevout hash, byte-reversed into display order the way the window store records
// it. Best-effort: a malformed PSBT returns null and the caller keeps the full
// window projection rather than guessing.
function revealCommitTxid(psbt) {
    try {
        const hash = psbt.txInputs[0].hash;
        if (!Buffer.isBuffer(hash) || hash.length !== 32) return null;
        return Buffer.from(hash).reverse().toString('hex');
    } catch (e) {
        return null;
    }
}

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
        let psbt;
        try {
            psbt = (typeof req.psbt === 'string')
                ? bitcoin.Psbt.fromHex(req.psbt, this.network ? { network: this.network } : undefined)
                : req.psbt;
        } catch (e) { return this._deny('PSBT_PARSE_FAILED', e.message); }
        if (!psbt) return this._deny('NO_PSBT');

        const inputs = req.inputs;
        if (!Array.isArray(inputs) || inputs.length === 0) return this._deny('NO_INPUTS_REQUESTED');

        // G14, before ANY per-input work: cap the requested count and the PSBT's
        // total input count. The second matters as much as the first, because the
        // BIP341 sighash commits to every prevout, so a one-element request against
        // a 5000-input PSBT still costs the full quadratic walk.
        if (inputs.length > this.maxCosignInputs)
            return this._deny('TOO_MANY_INPUTS',
                { requested: inputs.length, max: this.maxCosignInputs });
        if (psbt.txInputs.length > this.maxCosignInputs)
            return this._deny('TOO_MANY_INPUTS',
                { psbtInputs: psbt.txInputs.length, max: this.maxCosignInputs });

        // 1. Validate the requested set: in range, witnessUtxo present, no
        //    duplicates, and ALL spending the SAME account script (a mixed-account
        //    spend makes change-detection ambiguous - fail closed).
        const seenIdx = new Set();
        let accountScript = null;
        for (const it of inputs) {
            const i = it.index;
            if (!Number.isInteger(i) || i < 0 || i >= psbt.txInputs.length)
                return this._deny('INPUT_INDEX_OUT_OF_RANGE', { index: i });
            if (seenIdx.has(i)) return this._deny('DUPLICATE_INPUT_INDEX', { index: i });
            seenIdx.add(i);
            const wu = psbt.data.inputs[i] && psbt.data.inputs[i].witnessUtxo;
            if (!wu || !wu.script) return this._deny('CANNOT_CHECK_OUTPUTS', 'missing witnessUtxo for input ' + i);
            if (accountScript === null) accountScript = wu.script;
            else if (!wu.script.equals(accountScript)) return this._deny('MIXED_INPUT_SCRIPTS', { index: i });
        }

        // 1b. Envelope context (§3.9). Present only when the caller
        //     supplies the envelope SCRIPT; the script is not a trust transfer
        //     the way a raw tweak would be (G3), because this daemon parses it,
        //     matches it against the §3.2 grammar, checks it commits to this
        //     account's own aggregate key, and reads the ACTION it is being
        //     asked to approve straight out of it. The role is DERIVED from the
        //     PSBT, never taken from the request.
        //     A 2-of-3 account composes its own two recovery leaves into the
        //     commit tree alongside the envelope leaf (tree shape and
        //     rationale in envelope.js). Nothing is improvised: the leaves are
        //     re-derived here from the same three participant public keys that
        //     produced the account, so the commit output keeps the same
        //     two-of-three property the account has rather than stranding the
        //     prefunded reveal fee behind a lost co-signer.
        let env = null;
        if (req.envelope) {
            let script;
            try { script = Buffer.isBuffer(req.envelope.script) ? req.envelope.script : Buffer.from(String(req.envelope.script), 'hex'); }
            catch (e) { return this._deny('ENVELOPE_SCRIPT_INVALID', 'envelope.script is not hex'); }
            let commit;
            try {
                commit = deriveEnvelopeCommit({
                    internalXOnly:  this.internalXOnly,
                    envelopeScript: script,
                    recoveryLeaves: this.tapTree ? this.tapTree.recovery : null,
                    network:        this.network || undefined,
                });
            } catch (e) { return this._deny('ENVELOPE_SCRIPT_INVALID', e.message); }
            const role = classifyEnvelopeRole(psbt, commit);
            // No role means the PSBT neither funds this envelope nor spends its
            // commit: the script would be decoration, and the action it declares
            // would be one the transaction never carries.
            if (!role) return this._deny('ENVELOPE_NOT_COMMITTED',
                'this PSBT neither creates nor spends the commit output this envelope script derives');
            env = { commit, role, script };
        }

        // 2. Recover the action FROM the PSBT (never trust the caller's claim).
        //    On a COMMIT the action is not in the transaction at all: it lives in
        //    the leaf the commit output COMMITS to, so it is read from the script
        //    whose hash this daemon just matched against an output. On a
        //    REVEAL/CANCEL the leaf is in the PSBT and decodeActionFromPsbt finds
        //    it there.
        const decoded = (env && (env.role === 'commit' || env.role === 'cancel'))
            ? decodeEnvelopeAction(env.script)
            : decodeActionFromPsbt(psbt, { network: this.network });
        if (!decoded.ok) return this._deny('DECODE_' + decoded.reason, decoded.detail);

        // 3. Policy, against the server-side window snapshot. The decoded VERSION
        //    is passed too: the evaluator needs the exact (action, version) to know
        //    whether an amount cap can bind this format at all (G2) and whether the
        //    format can honour allowedDestinations (G9).
        //
        //    A CANCEL is the one request that skips policy, because it publishes
        //    NO ACTION AT ALL: it spends an unrevealed commit back to the
        //    account, so there is nothing for policy to authorize, and the
        //    output gate below is what bounds where the value goes. Gating it on
        //    policy would mean that tightening a policy (or retiring an action
        //    from allowedActions) permanently strands whatever sits in an
        //    unrevealed commit, turning a recovery path into a way to lose funds.
        //    "Publishes no action at all" is a premise the OUTPUT GATE has to keep
        //    true: _checkOutputs refuses every OP_RETURN on an envelope role, so a
        //    cancel cannot carry one. Weaken that refusal and this skip becomes an
        //    unjudged signing path.
        //
        //    A REVEAL is judged against the window MINUS its own commit's entry,
        //    when this daemon recorded one. Step 10 charges an envelope once, at
        //    the commit, but the reveal was still evaluated against the full
        //    snapshot, so the evaluator projected a SECOND expenditure for an
        //    action already paid for: with maxActions:1 the commit passes, fills
        //    the window and its own reveal is denied POLICY_WINDOW_COUNT_EXCEEDED,
        //    leaving a broadcast commit stuck until the window expires or the
        //    agent pays to cancel. Removing that one entry is not a relaxation of
        //    the window: the reveal is judged on exactly the usage its commit was,
        //    with every other gate (allowedActions, per-action cap, destinations,
        //    confirmAbove) untouched. It applies ONLY where the store holds a live
        //    entry for the commit outpoint this reveal spends, so a commit this
        //    daemon never charged keeps the full projection and fails closed.
        let windowUsage = this.windowStore ? this.windowStore.snapshot() : undefined;
        if (this.windowStore && env && env.role === 'reveal') {
            const adjusted = this.windowStore.snapshotExcludingTxid(revealCommitTxid(psbt));
            if (adjusted) windowUsage = adjusted;
        }
        let verdict = { ok: true, evaluation: {} };
        if (!env || env.role !== 'cancel') {
            verdict = evaluatePolicy(this.policy,
                { action: decoded.action, version: decoded.version, params: decoded.params }, windowUsage);
            if (!verdict.ok) return this._deny(verdict.violation.code, verdict.violation.details);

            // 4. Confirm-required actions: a headless daemon cannot prompt, so deny by default.
            if (verdict.evaluation.needsConfirmation && !this.allowConfirmable)
                return this._deny('CONFIRMATION_REQUIRED',
                    { action: decoded.action, amount: verdict.evaluation.amount });
        }

        // 5. Prevout gate: verify every input we are about to sign for actually
        //    spends THIS account's derived scriptPubKey, not a caller-supplied
        //    witnessUtxo pointing at a foreign script. Must run before any budget
        //    consumption below.
        const prevoutDenial = this._checkPrevouts(psbt, inputs.map((it) => it.index),
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
        const sourceDenial = this._checkSource(psbt, seenIdx,
            env && env.role !== 'commit' ? env.commit.output : null);
        if (sourceDenial) return sourceDenial;

        // 6. Output gate: the action string does not constrain where the native coin
        //    goes, so refuse any output that is not the data carrier, change-to-self,
        //    or operator-authorized. Blocks a benign-action / drain-output craft.
        //    Once, since all signed inputs share accountScript by the check above.
        const outDenial = this._checkOutputs(psbt, inputs[0].index, env);
        if (outDenial) return outDenial;

        // 7. Fee gate: the output gate stops diversion but not a change-omission
        //    burn that hands the whole account balance to miners as fee.
        const feeDenial = this._checkFee(psbt);
        if (feeDenial) return feeDenial;

        // 8. Reject any sighash type that does not commit to every output. A
        //    NONE/SINGLE/ANYONECANPAY partial would let the agent reassemble a
        //    drain tx that still verifies, bypassing the output gate above.
        if (!sighashAllowed(req.sighashType))
            return this._deny('SIGHASH_TYPE_NOT_ALLOWED', { sighashType: req.sighashType });

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
        const envTweaks = envelopeRoundTweaks(env, this.tweaks);
        for (const it of inputs) {
            let msg;
            try {
                msg = (env && env.role === 'reveal')
                    ? envelopeScriptPathSighash(psbt, it.index, req.sighashType, env.commit.leafHash)
                    : taprootKeyPathSighash(psbt, it.index, req.sighashType);
            }
            catch (e) { return this._deny('CANNOT_DERIVE_SIGHASH', e.message); }
            let det;
            try {
                det = this.musig.deterministicSign({
                    secretKey:         this.secretKey,
                    otherPublicNonces: [toBytes(it.agentPublicNonce, 'agentPublicNonce')],
                    publicKeys:        this.publicKeys,
                    tweaks:            envTweaks,
                    msg,
                });
            } catch (e) { return this._deny('SIGN_FAILED', e.message); }
            signatures.push({
                index:       it.index,
                publicNonce: Buffer.from(det.publicNonce).toString('hex'),
                sig:         Buffer.from(det.sig).toString('hex'),
                msg:         Buffer.from(msg).toString('hex'),
            });
        }

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
        if (!env || env.role === 'commit') this._recordBudget(psbt, verdict.evaluation);

        return { approved: true, action: decoded.action, signatures,
                 envelopeRole: env ? env.role : undefined };
    },

    // Source gate (G16). `signed` is the set of input indexes this request signs.
    // Input 0 must be among them AND spend this account's script: the prevout gate
    // proves the second for every signed input, so membership is the load-bearing
    // half, and the script re-check keeps this correct if the gates are ever
    // reordered.
    // `expectedScript` mirrors _checkPrevouts: an envelope REVEAL or CANCEL has
    // the commit outpoint at input 0 by construction (§3.5 pins it there, and
    // the decoder's recognition depends on it), so the script to expect is the
    // commit's. The gate itself is unchanged in force: input 0 must still be one
    // of the inputs we sign, and must still spend a script this daemon derived
    // rather than one the caller named.
    _checkSource(psbt, signed, expectedScript) {
        const expected = expectedScript || this.accountScript;
        if (!signed.has(0))
            return this._deny('SOURCE_NOT_OUR_ACCOUNT',
                { detail: 'input 0 is the action\'s protocol source but is not one of the inputs being co-signed' });
        const inp = psbt.data.inputs[0];
        if (!inp || !inp.witnessUtxo || !inp.witnessUtxo.script)
            return this._deny('SOURCE_NOT_OUR_ACCOUNT', { detail: 'input 0 has no witnessUtxo' });
        if (!inp.witnessUtxo.script.equals(expected))
            return this._deny('SOURCE_NOT_OUR_ACCOUNT', {
                expected: expected.toString('hex'),
                got:      inp.witnessUtxo.script.toString('hex'),
            });
        return null;
    },

    // Record one window entry for the whole tx (single authorization). The txid is
    // fixed pre-signature for segwit/taproot inputs, so it is a stable audit key;
    // best-effort (null if reconstruction fails). No-op without a window store.
    _recordBudget(psbt, evaluation) {
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
