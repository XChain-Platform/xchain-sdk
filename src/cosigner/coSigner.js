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
 * XChain Platform SDK - MuSig2 Co-Signer Service
 *
 * The hard-enforcement endpoint for AgentSession: holds one key of a
 * MuSig2 group and produces its partial signature ONLY for actions that
 * pass policy. Out-of-policy -> it withholds the partial, so the 2-of-N
 * spend cannot complete. On-chain the result is a single Schnorr sig
 * (co-signing leaves no footprint).
 *
 * Security stance (transport-agnostic core; wrap with server.js):
 *   - The PSBT is the authority. The action is decoded FROM the PSBT
 *     (decodeActionFromPsbt), never trusted from the caller.
 *   - The message signed is DERIVED from the PSBT (the BIP341 key-path
 *     sighash), never trusted from the caller. So the caller cannot show
 *     a benign PSBT for policy yet obtain a signature over a different tx.
 *   - Fail closed everywhere: any decode failure, policy denial, missing
 *     witnessUtxo, or confirm-required (a headless daemon cannot prompt)
 *     returns { approved:false, reason } and signs nothing.
 *
 * SCOPE (slice 3): key-path P2TR spend of a configured aggregate (the
 * 2-of-2 case; the deterministic signer is this co-signer, the agent is
 * the live signer). The taproot tweak is supplied at construction (an
 * address-setup concern), not re-derived here. The 2-of-3 recovery tree
 * and native-coin output-leg cross-checks are later slices.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const MuSig2  = require('../musig2.js');
const { evaluatePolicy } = require('./policyEvaluator.js');
const { decodeActionFromPsbt } = require('./psbtActionDecode.js');

// Taproot operations (p2tr derivation, key-path sighash) require an ECC backend.
// initEccLib sets a bitcoinjs global; idempotent and safe to call on module load.
bitcoin.initEccLib(ecc);

function toBytes(v, label) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return Buffer.from(v, 'hex');
    throw new Error(label + ' must be a hex string or Uint8Array');
}

// BIP341 key-path sighash for one input, reconstructed from the PSBT. Requires a
// witnessUtxo on EVERY input (the sighash commits to all prevouts); throws if any
// is missing, so the caller fails closed rather than signing a half-known tx.
function taprootKeyPathSighash(psbt, inputIndex, hashType) {
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

class CoSigner {

    /*
     * @param {object} config
     *   secretKey       {Uint8Array|hex}  this co-signer's 32-byte key
     *   publicKeys      {(Uint8Array|hex)[]}  full signer set incl. ours, in the agreed order
     *   policy          normalized policy (see policyEvaluator)
     *   windowStore     {WindowStore}  optional; required if policy.maxPerWindow is set
     *   tweaks          {{tweak,xOnly}[]}  optional; the taproot tweak applied at address setup
     *   network         bitcoinjs network (optional, for hex PSBT parsing)
     *   allowConfirmable {boolean}  default false; a headless daemon denies confirm-required actions
     */
    constructor(config = {}) {
        this.secretKey  = toBytes(config.secretKey, 'secretKey');
        if (this.secretKey.length !== 32) throw new Error('secretKey must be 32 bytes');
        if (!Array.isArray(config.publicKeys) || config.publicKeys.length < 2)
            throw new Error('publicKeys must list the full signer set (>= 2)');
        this.publicKeys = config.publicKeys;
        if (!config.policy || !config.policy.allowedActions)
            throw new Error('a normalized policy with allowedActions is required');
        this.policy = config.policy;
        if (this.policy.maxPerWindow && !config.windowStore)
            throw new Error('policy.maxPerWindow requires a windowStore (server-side budget)');
        this.windowStore = config.windowStore || null;
        this.tweaks = config.tweaks || [];
        this.network = config.network || null;
        this.allowConfirmable = config.allowConfirmable === true;
        this.musig = new MuSig2();
    }

    _deny(reason, detail) { return { approved: false, reason, detail: detail || null }; }

    /*
     * Decide and (if approved) partial-sign.
     *
     * @param {object} req
     *   psbt              {string} PSBT hex (or a bitcoin.Psbt)
     *   agentPublicNonce  {Uint8Array|hex} the live signer's 66-byte public nonce
     *   inputIndex        {number} the input this group signs (default 0)
     *   sighashType       {number} optional; default SIGHASH_DEFAULT
     * @returns {object}
     *   { approved:false, reason, detail }
     *   { approved:true, publicNonce, sig, msg }  (all hex)
     */
    process(req = {}) {
        let psbt;
        try {
            psbt = (typeof req.psbt === 'string')
                ? bitcoin.Psbt.fromHex(req.psbt, this.network ? { network: this.network } : undefined)
                : req.psbt;
        } catch (e) { return this._deny('PSBT_PARSE_FAILED', e.message); }
        if (!psbt) return this._deny('NO_PSBT');

        // 1. Recover the action FROM the PSBT (never trust the caller's claim).
        const decoded = decodeActionFromPsbt(psbt, { network: this.network });
        if (!decoded.ok) return this._deny('DECODE_' + decoded.reason, decoded.detail);

        // 2. Policy, against the server-side window snapshot.
        const windowUsage = this.windowStore ? this.windowStore.snapshot() : undefined;
        const verdict = evaluatePolicy(this.policy,
            { action: decoded.action, params: decoded.params }, windowUsage);
        if (!verdict.ok) return this._deny(verdict.violation.code, verdict.violation.details);

        // 3. Confirm-required actions: a headless daemon cannot prompt, so deny by default.
        if (verdict.evaluation.needsConfirmation && !this.allowConfirmable)
            return this._deny('CONFIRMATION_REQUIRED',
                { action: decoded.action, amount: verdict.evaluation.amount });

        // 4. Derive the message FROM the PSBT (never trust a caller-supplied sighash).
        let msg;
        try {
            const idx = Number.isInteger(req.inputIndex) ? req.inputIndex : 0;
            msg = taprootKeyPathSighash(psbt, idx, req.sighashType);
        } catch (e) { return this._deny('CANNOT_DERIVE_SIGHASH', e.message); }

        // 5. Stateless partial signature (the co-signer is the deterministic signer).
        let det;
        try {
            det = this.musig.deterministicSign({
                secretKey:         this.secretKey,
                otherPublicNonces: [toBytes(req.agentPublicNonce, 'agentPublicNonce')],
                publicKeys:        this.publicKeys,
                tweaks:            this.tweaks,
                msg,
            });
        } catch (e) { return this._deny('SIGN_FAILED', e.message); }

        // 6. Consume the budget on authorization (conservative: even if the agent
        //    never completes the aggregate, the cap is already spent). The txid is
        //    fixed pre-signature for segwit/taproot inputs, so it is a stable audit
        //    key; best-effort (null if reconstruction fails).
        if (this.windowStore) {
            let txid = null;
            try {
                const tx = new bitcoin.Transaction();
                tx.version = psbt.version;
                tx.locktime = psbt.locktime;
                for (const ti of psbt.txInputs)  tx.addInput(ti.hash, ti.index, ti.sequence);
                for (const to of psbt.txOutputs) tx.addOutput(to.script, to.value);
                txid = tx.getId();
            } catch (e) { /* audit txid is best-effort */ }
            this.windowStore.record({
                action: verdict.evaluation.action,
                tick:   verdict.evaluation.tick,
                amount: verdict.evaluation.amount,
                txid,
            });
        }

        return {
            approved:    true,
            publicNonce: Buffer.from(det.publicNonce).toString('hex'),
            sig:         Buffer.from(det.sig).toString('hex'),
            msg:         Buffer.from(msg).toString('hex'),
            action:      decoded.action,
        };
    }
}

module.exports = CoSigner;
module.exports.taprootKeyPathSighash = taprootKeyPathSighash;
