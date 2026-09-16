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
 * XChain Platform SDK - Co-Signer Request Preparation
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const { evaluatePolicy } = require('../policy_evaluator.js');
const { decodeActionFromPsbt, decodeEnvelopeAction } = require('../psbt_action_decode.js');
const { deriveEnvelopeCommit, classifyEnvelopeRole } = require('../envelope.js');

// Parse and bound the request before any input-specific work begins.
function readRequest(self, req) {
    let psbt;
    try {
        psbt = (typeof req.psbt === 'string')
            ? bitcoin.Psbt.fromHex(req.psbt, self.network ? { network: self.network } : undefined)
            : req.psbt;
    } catch (e) { return { denial: self._deny('PSBT_PARSE_FAILED', e.message) }; }
    if (!psbt) return { denial: self._deny('NO_PSBT') };

    const inputs = req.inputs;
    if (!Array.isArray(inputs) || inputs.length === 0)
        return { denial: self._deny('NO_INPUTS_REQUESTED') };

    // G14, before ANY per-input work: cap the requested count and the PSBT's
    // total input count. The second matters as much as the first, because the
    // BIP341 sighash commits to every prevout, so a one-element request against
    // a 5000-input PSBT still costs the full quadratic walk.
    if (inputs.length > self.maxCosignInputs)
        return { denial: self._deny('TOO_MANY_INPUTS',
            { requested: inputs.length, max: self.maxCosignInputs }) };
    if (psbt.txInputs.length > self.maxCosignInputs)
        return { denial: self._deny('TOO_MANY_INPUTS',
            { psbtInputs: psbt.txInputs.length, max: self.maxCosignInputs }) };
    return { psbt, inputs };
}

// Validate the requested input set once so later gates share its account identity.
function validateInputs(self, psbt, inputs) {
    // 1. Validate the requested set: in range, witnessUtxo present, no
    //    duplicates, and ALL spending the SAME account script (a mixed-account
    //    spend makes change-detection ambiguous - fail closed).
    const seenIdx = new Set();
    let accountScript = null;
    for (const it of inputs) {
        const i = it.index;
        if (!Number.isInteger(i) || i < 0 || i >= psbt.txInputs.length)
            return { denial: self._deny('INPUT_INDEX_OUT_OF_RANGE', { index: i }) };
        if (seenIdx.has(i)) return { denial: self._deny('DUPLICATE_INPUT_INDEX', { index: i }) };
        seenIdx.add(i);
        const wu = psbt.data.inputs[i] && psbt.data.inputs[i].witnessUtxo;
        if (!wu || !wu.script)
            return { denial: self._deny('CANNOT_CHECK_OUTPUTS', 'missing witnessUtxo for input ' + i) };
        if (accountScript === null) accountScript = wu.script;
        else if (!wu.script.equals(accountScript))
            return { denial: self._deny('MIXED_INPUT_SCRIPTS', { index: i }) };
    }
    return { seenIdx };
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
// Derive envelope context locally so the request cannot assert its signing role.
function deriveEnvelope(self, req, psbt) {
    let env = null;
    if (req.envelope) {
        let script;
        try {
            script = Buffer.isBuffer(req.envelope.script)
                ? req.envelope.script : Buffer.from(String(req.envelope.script), 'hex');
        } catch (e) {
            return { denial: self._deny('ENVELOPE_SCRIPT_INVALID', 'envelope.script is not hex') };
        }
        let commit;
        try {
            commit = deriveEnvelopeCommit({
                internalXOnly:  self.internalXOnly,
                envelopeScript: script,
                recoveryLeaves: self.tapTree ? self.tapTree.recovery : null,
                network:        self.network || undefined,
            });
        } catch (e) { return { denial: self._deny('ENVELOPE_SCRIPT_INVALID', e.message) }; }
        const role = classifyEnvelopeRole(psbt, commit);
        // No role means the PSBT neither funds this envelope nor spends its
        // commit: the script would be decoration, and the action it declares
        // would be one the transaction never carries.
        if (!role) return { denial: self._deny('ENVELOPE_NOT_COMMITTED',
            'this PSBT neither creates nor spends the commit output this envelope script derives') };
        env = { commit, role, script };
    }
    return { env };
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

// Decode and evaluate policy before transaction and signature gates run.
function evaluateRequest(self, psbt, env) {
    // 2. Recover the action FROM the PSBT (never trust the caller's claim).
    //    On a COMMIT the action is not in the transaction at all: it lives in
    //    the leaf the commit output COMMITS to, so it is read from the script
    //    whose hash this daemon just matched against an output. On a
    //    REVEAL/CANCEL the leaf is in the PSBT and decodeActionFromPsbt finds
    //    it there.
    const decoded = (env && (env.role === 'commit' || env.role === 'cancel'))
        ? decodeEnvelopeAction(env.script)
        : decodeActionFromPsbt(psbt, { network: self.network });
    if (!decoded.ok) return { denial: self._deny('DECODE_' + decoded.reason, decoded.detail) };

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
    let windowUsage = self.windowStore ? self.windowStore.snapshot() : undefined;
    if (self.windowStore && env && env.role === 'reveal') {
        const adjusted = self.windowStore.snapshotExcludingTxid(revealCommitTxid(psbt));
        if (adjusted) windowUsage = adjusted;
    }
    let verdict = { ok: true, evaluation: {} };
    if (!env || env.role !== 'cancel') {
        verdict = evaluatePolicy(self.policy,
            { action: decoded.action, version: decoded.version, params: decoded.params }, windowUsage);
        if (!verdict.ok) return { denial: self._deny(verdict.violation.code, verdict.violation.details) };

        // 4. Confirm-required actions: a headless daemon cannot prompt, so deny by default.
        if (verdict.evaluation.needsConfirmation && !self.allowConfirmable)
            return { denial: self._deny('CONFIRMATION_REQUIRED',
                { action: decoded.action, amount: verdict.evaluation.amount }) };
    }
    return { decoded, verdict };
}

module.exports = { readRequest, validateInputs, deriveEnvelope, revealCommitTxid, evaluateRequest };
