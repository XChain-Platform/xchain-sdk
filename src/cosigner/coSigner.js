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
 *   - The tx OUTPUTS are gated too (_checkOutputs): the action string can't
 *     constrain where the native coin goes, so only the OP_RETURN carrier,
 *     change back to the spent account, and operator-authorized outputs are
 *     allowed. This blocks a benign-action-with-drain-output craft.
 *   - The miner FEE is reconciled too (_checkFee): the action string never
 *     constrains the fee, so an omitted/undersized change output would hand the
 *     whole account balance to miners as fee. The daemon computes
 *     sum(inputs) - sum(outputs) from the mandatory witnessUtxos and refuses a
 *     value-negative tx, the full burn (nothing returned to any output), or a
 *     fee above the operator-set maxFeeSats cap.
 *   - Fail closed everywhere: any decode failure, policy denial, missing
 *     witnessUtxo, unauthorized output, or confirm-required (a headless
 *     daemon cannot prompt) returns { approved:false, reason } and signs nothing.
 *
 * SCOPE (slice 3): key-path P2TR spend of a configured aggregate (the
 * 2-of-2 case; the deterministic signer is this co-signer, the agent is
 * the live signer). The taproot tweak is DERIVED here from the participant
 * public keys, never supplied: a raw tweak is an opaque commitment to a
 * script tree the daemon cannot inspect, so accepting one lets whoever
 * supplies it hide a unilateral spend path (see the constructor, G3). A
 * 2-of-3 account is configured by naming recoveryPublicKey.
 * COINPAY/native-fee output legs are supported only when the
 * operator allow-lists them via config.allowedOutputs (default: none, so
 * plain token SEND - OP_RETURN + change only - passes). EXECUTE, DEPLOY
 * v0/v2, and LIST use rest-field formats (`...PARAMS`) that
 * decodeActionFromPsbt refuses outright (REST_FIELD_UNSUPPORTED) before any
 * params are built; they are currently outside this co-signer's decodable
 * scope and are denied at decode regardless of allowedActions.
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc     = require('@bitcoinerlab/secp256k1');
const MuSig2  = require('../musig2.js');
const { evaluatePolicy } = require('./policyEvaluator.js');
const { decodeActionFromPsbt, decodeEnvelopeAction } = require('./psbtActionDecode.js');
const { deriveMuSig2P2TR2of3 } = require('./account.js');
const { isCapInert } = require('./valueDerivability.js');

// Taproot operations (p2tr derivation, key-path sighash) require an ECC backend.
// initEccLib sets a bitcoinjs global; idempotent and safe to call on module load.
bitcoin.initEccLib(ecc);

function toBytes(v, label) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return Buffer.from(v, 'hex');
    throw new Error(label + ' must be a hex string or Uint8Array');
}

// SIGHASH_DEFAULT (0x00) is the only type honored past this gate. SIGHASH_ALL
// (0x01) also commits to ALL outputs and would be equally safe from the output-
// gate's point of view, but the witness-assembly side (musig2Signer.js) writes
// a bare 64-byte tapKeySig with no trailing sighash-flag byte, which BIP341
// only permits for SIGHASH_DEFAULT; a non-default type here would sign
// something the rest of the pipeline cannot correctly finalize. NONE/SINGLE
// and ANYONECANPAY additionally let a caller obtain a partial signature over a
// message that does not bind the outputs the co-signer just gated, then
// reassemble a drain transaction that still verifies on-chain. `undefined`
// defaults to SIGHASH_DEFAULT and is allowed.
const ALLOWED_SIGHASH = new Set([bitcoin.Transaction.SIGHASH_DEFAULT]);
function sighashAllowed(hashType) {
    return hashType === undefined || ALLOWED_SIGHASH.has(hashType);
}

// The five standard single-recipient payment templates. Anything else - bare
// multisig above all - is refused as an allowedOutputs entry (see
// _normalizeAllowedOutputs, G7). Matching is structural, on the decompiled
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

// Default ceiling on both the requested and the PSBT-total input count (G14).
// Comfortably above any realistic agent spend, far below the point where the
// quadratic sighash work becomes a denial of service.
const DEFAULT_MAX_COSIGN_INPUTS = 32;

//  §3.9: the Taproot envelope needs a tap-tweaked key path, a script
// path, and an action read out of a leaf script. All three derive from public
// bytes in cosigner/envelope.js, so the daemon and the agent compute them
// independently and neither has to trust the other's tweak (the G3 property).
const {
    deriveEnvelopeCommit, classifyEnvelopeRole, envelopeScriptPathSighash,
} = require('./envelope.js');

// BIP341 key-path sighash for one input, reconstructed from the PSBT. Requires a
// witnessUtxo on EVERY input (the sighash commits to all prevouts); throws if any
// is missing, so the caller fails closed rather than signing a half-known tx.
function taprootKeyPathSighash(psbt, inputIndex, hashType) {
    // Defense in depth: never derive a signing message under a sighash type that
    // does not commit to every output. The process() sighash guard rejects it
    // earlier with a clearer code; this also protects any other caller of this export.
    if (!sighashAllowed(hashType))
        throw new Error('disallowed sighashType 0x' + Number(hashType).toString(16).padStart(2, '0') + ' (only SIGHASH_DEFAULT is finalizable by this signer)');
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
     *   recoveryPublicKey {Uint8Array|hex}  2-of-3 only: the operator-recovery party's key.
     *                   The daemon derives the tap tree AND its own key-path tweak from
     *                   [agent, daemon, recovery]; a raw tweak is never accepted (G3).
     *   network         bitcoinjs network (optional, for hex PSBT parsing)
     *   allowConfirmable {boolean}  default false; a headless daemon denies confirm-required actions
     *   maxCosignInputs {number}  default 32; ceiling on BOTH the requested input
     *                   count and the PSBT's total input count (G14)
     */
    constructor(config = {}) {
        this.secretKey  = toBytes(config.secretKey, 'secretKey');
        if (this.secretKey.length !== 32) throw new Error('secretKey must be 32 bytes');
        // EXACTLY two: the daemon returns ONE partial and the agent aggregates it
        // with its own, so a larger set funds an address the cooperative path can
        // never spend. The 2-of-3 account names its third key as recoveryPublicKey.
        if (!Array.isArray(config.publicKeys) || config.publicKeys.length !== 2)
            throw new Error('publicKeys must be exactly the [agent, daemon] pair '
                + '(a 2-of-3 account names its third key as recoveryPublicKey)');
        this.publicKeys = config.publicKeys;
        if (!config.policy || !config.policy.allowedActions)
            throw new Error('a normalized policy with allowedActions is required');
        this.policy = config.policy;
        if (this.policy.maxPerWindow && !config.windowStore)
            throw new Error('policy.maxPerWindow requires a windowStore (server-side budget)');
        this.windowStore = config.windowStore || null;
        this.network = config.network || null;

        // G2: an amount cap keyed on an action whose every decodable format
        // defines its value by ACTION_INDEX reference can never fire - the
        // daemon cannot read the referenced object, so the amount is always
        // undefined and every amount gate skips. Left alone that is a policy the
        // operator believes is enforced and which is in fact decorative. Reject
        // it here, at construction, rather than at sign time.
        // maxPerAction is the only policy table keyed by ACTION (maxPerWindow.perTick
        // and confirmAbove.perTick are keyed by tick), so it is the only place an
        // action name can be written into an amount limit.
        if (config.policy.maxPerAction) {
            for (const action of Object.keys(config.policy.maxPerAction))
                if (isCapInert(action))
                    throw new Error(`policy.maxPerAction.${action} can never bind: every decodable ` +
                        `${action} format defines its value by reference to an on-chain object the ` +
                        `co-signer cannot read, so the cap would be silently inert. Remove the cap ` +
                        `(the output gate + maxFeeSats bound ${action}), or disallow the action.`);
        }

        // G3: the taproot tweak is DERIVED here, never accepted from the caller.
        // `tweak = taggedHash('TapTweak', internal || merkleRoot)` is an opaque
        // 32 bytes: a daemon handed that value cannot tell which tap tree it
        // commits to, so whoever supplies it chooses the tree. A compromised
        // agent supplying a tweak computed over a tree containing
        // `<agentPubkey> OP_CHECKSIG` yields exactly the funded address, passes
        // every gate, and then spends the whole account unilaterally through a
        // script path - no daemon, no policy, no window, and on-chain
        // indistinguishable from a cooperative spend. So `tweaks` is gone as a
        // configuration surface, and the 2-of-3 account is configured by naming
        // the third PUBLIC KEY, which the daemon can verify by re-deriving the
        // whole tree (and therefore the address) itself.
        if (config.tweaks !== undefined && !(Array.isArray(config.tweaks) && config.tweaks.length === 0))
            throw new Error('config.tweaks is not accepted: a supplied taproot tweak is an unverifiable ' +
                'commitment to an arbitrary script tree (an agent-chosen tree grants the agent a ' +
                'unilateral script-path spend). Configure a 2-of-3 account with recoveryPublicKey ' +
                'instead, and the daemon derives the tree itself.');

        this.recoveryPublicKey = config.recoveryPublicKey || null;
        if (this.recoveryPublicKey) {
            if (this.publicKeys.length !== 2)
                throw new Error('recoveryPublicKey requires exactly the [agent, daemon] pair in publicKeys ' +
                    '(the recovery key is the third party and is named separately)');
            let tree;
            try {
                tree = deriveMuSig2P2TR2of3({
                    agent:    this.publicKeys[0],
                    daemon:   this.publicKeys[1],
                    recovery: this.recoveryPublicKey,
                }, this.network || undefined);
            } catch (e) {
                throw new Error('failed to derive the 2-of-3 tap tree from publicKeys/recoveryPublicKey: ' + e.message);
            }
            this.tweaks = tree.keyPath.tweaks;
            this.tapTree = tree;
        } else {
            // Plain 2-of-2: the BIP-327 aggregate IS the taproot output key, with
            // no tweak. That is hidden-leaf-safe by construction - producing a
            // valid control block against an untweaked output key would need a
            // discrete-log relation - precisely because the output key is a key
            // aggregate with key coefficients no single participant can steer.
            this.tweaks = [];
            this.tapTree = null;
        }
        this.allowConfirmable = config.allowConfirmable === true;
        // Operator-authorized non-change outputs (COINPAY native legs, the
        // protocol-fee output). Everything NOT in this set, change-to-self, or the
        // OP_RETURN carrier is treated as a drain and refused (see _checkOutputs).
        this.allowedOutputs = this._normalizeAllowedOutputs(config.allowedOutputs || []);
        // Anti-burn fee reconciliation (see _checkFee). maxFeeSats is an optional
        // operator-set absolute cap (satoshis). It is the only bound that can
        // safely be tightened past the always-on guards, because a legitimate fee
        // fraction is chain-specific (a low-unit-value chain can pay ~all of a
        // small input as fee), so no proportional default can tell a legitimate
        // high fee from a drain without operator knowledge.
        this.maxFeeSats = (config.maxFeeSats === undefined || config.maxFeeSats === null)
            ? null : Number(config.maxFeeSats);
        if (this.maxFeeSats !== null && (!Number.isInteger(this.maxFeeSats) || this.maxFeeSats < 0))
            throw new Error('maxFeeSats must be a non-negative integer');
        // G14: the body-size limit bounds BYTES, not WORK. Sighash derivation
        // re-copies every prevout script and value per signed input, so the cost is
        // quadratic in the PSBT's input count, plus one deterministicSign each. A
        // single crafted request could occupy the single-threaded sidecar for
        // seconds and a modest stream of them is a sustained freeze - which, per the
        // threat model, is permanently stuck funds on a plain 2-of-2. Cap both the
        // requested count and the PSBT's TOTAL input count, since the sighash walks
        // every input whether or not we sign it.
        this.maxCosignInputs = (config.maxCosignInputs === undefined || config.maxCosignInputs === null)
            ? DEFAULT_MAX_COSIGN_INPUTS : Number(config.maxCosignInputs);
        if (!Number.isInteger(this.maxCosignInputs) || this.maxCosignInputs < 1)
            throw new Error('maxCosignInputs must be a positive integer');

        this.musig = new MuSig2();

        // The account scriptPubKey this daemon actually spends from, derived ONLY
        // from the participant keys, never trusted from a caller-supplied
        // witnessUtxo.script (see _checkPrevouts). Covers both the plain 2-of-2 key
        // path (no tweak) and the tweaked 2-of-3 cooperative key path, whose tweak
        // this constructor derived above from the three participant keys.
        //
        // There is deliberately no `accountScript` config override. It had no
        // consumer, its only effect was to WEAKEN the prevout gate (the one gate
        // that proves the inputs being signed really belong to this account), and
        // the best case for a wrong value was a liveness break. Tests derive the
        // script exactly as production does.
        try {
            const agg = this.musig.aggregateKeys(this.publicKeys, this.tweaks);
            const p2tr = bitcoin.payments.p2tr({
                pubkey:  Buffer.from(agg.xOnlyPubkey),
                network: this.network || undefined,
            });
            this.accountScript = p2tr.output;
            // Kept for the envelope surface: the commit output is
            // p2tr(internal = this aggregate, tree = {envelope leaf}), so the
            // internal key is the account's own aggregate key.
            this.aggregateXOnly = Buffer.from(agg.xOnlyPubkey);
        } catch (e) {
            throw new Error('failed to derive the account scriptPubKey from the participant keys: ' + e.message);
        }
    }

    _deny(reason, detail) { return { approved: false, reason, detail: detail || null }; }

    // Normalize the allow-list once at construction (throws on bad config, never at
    // sign time). Each entry: { address | script, maxValue? }.
    _normalizeAllowedOutputs(list) {
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
            const maxValue = Number(o.maxValue);
            if (!Number.isFinite(maxValue) || maxValue < 0)
                throw new Error(`allowedOutputs[${i}].maxValue must be a non-negative number`);
            return { script, maxValue };
        });
    }

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
    _checkOutputs(psbt, idx, env) {
        const inp = psbt.data.inputs[idx];
        if (!inp || !inp.witnessUtxo || !inp.witnessUtxo.script)
            return this._deny('CANNOT_CHECK_OUTPUTS', 'signed input has no witnessUtxo');
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
            let decomp = null;
            try { decomp = bitcoin.script.decompile(out.script); } catch (e) { /* non-standard */ }
            if (decomp && decomp[0] === bitcoin.opcodes.OP_RETURN) {
                if (Number(out.value) > 0)
                    return this._deny('OP_RETURN_CARRIES_VALUE', { index: i, value: out.value });
                continue;
            }
            // (b) Change back to the account we spend from stays under co-signer control.
            if (out.script.equals(accountScript)) continue;
            // (b2) The envelope commit output on a COMMIT request. Its value is
            //      the reveal's prefunded miner fee plus one dust change, so it
            //      leaves the account for good and is bounded by maxFeeSats:
            //      without that cap an "envelope" is an unbounded drain wearing
            //      a commit output's shape. Exactly one is authorized; a second
            //      would be a second, ungated envelope on the same transaction.
            if (env && env.role === 'commit' && out.script.equals(env.commit.output)) {
                if (commitOutputsSeen++ > 0)
                    return this._deny('UNAUTHORIZED_OUTPUT', { index: i, detail: 'more than one envelope commit output' });
                if (this.maxFeeSats === null)
                    return this._deny('ENVELOPE_COMMIT_UNBOUNDED',
                        'an envelope commit prefunds the reveal fee, so maxFeeSats must be set to bound it');
                if (Number(out.value) > this.maxFeeSats)
                    return this._deny('OUTPUT_OVER_CAP',
                        { index: i, value: out.value, maxValue: this.maxFeeSats, detail: 'envelope commit output' });
                continue;
            }
            // (c) An operator-authorized native leg (COINPAY recipient / fee output).
            const match = this.allowedOutputs.find((a) => out.script.equals(a.script));
            if (match) {
                const total = (spent.get(match) || 0) + Number(out.value);
                spent.set(match, total);
                // maxValue is mandatory since G7, so this is always a real bound.
                if (total > match.maxValue)
                    return this._deny('OUTPUT_OVER_CAP', { index: i, value: out.value, total, maxValue: match.maxValue });
                continue;
            }
            // Anything else is an unauthorized native-coin drain.
            return this._deny('UNAUTHORIZED_OUTPUT', { index: i, value: out.value });
        }
        return null;
    }

    // Anti-burn gate: _checkOutputs blocks value DIVERSION, but the action string
    // never constrains the miner FEE, so a malicious agent can still burn the whole
    // account by omitting (or undersizing) the change output, leaving the entire
    // remainder = sum(inputs) - sum(outputs) to miners behind a benign in-policy
    // action. setMaximumFeeRate (musig2Signer.js/wallet.js) runs only on the
    // attacker-controlled client, so the daemon reconciles the fee itself here from
    // data it already holds: every input's witnessUtxo.value (mandatory for the
    // sighash). Always-on, false-positive-free guards: fee uncomputable (an input
    // has no witnessUtxo value), a value-negative (unrelayable) tx, and the
    // canonical full burn where every satoshi becomes fee because no output
    // returns any value (totalOut === 0). A tighter bound (e.g. catching an
    // undersized dust-change drain, which is indistinguishable from a legitimate
    // high fee without chain knowledge) needs the operator's maxFeeSats cap.
    // Returns a denial object, or null when the fee is within bounds.
    // Values arrive as Number OR BigInt: applyBufferutilsPatch.js teaches
    // bip174/bitcoinjs to carry satoshi values above 2^53-1 (e.g. large DOGE
    // UTXOs) as BigInt (see narrowU64). The arithmetic below is done entirely
    // in BigInt so a >2^53 value is neither rejected outright nor rounded.
    _toU64(v) {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
        return null;
    }

    _checkFee(psbt) {
        let totalIn = 0n;
        for (let i = 0; i < psbt.txInputs.length; i++) {
            const wu = psbt.data.inputs[i] && psbt.data.inputs[i].witnessUtxo;
            const v = wu ? this._toU64(wu.value) : null;
            if (v === null)
                return this._deny('CANNOT_CHECK_FEE', 'input ' + i + ' has no witnessUtxo value');
            totalIn += v;
        }
        let totalOut = 0n;
        for (const out of psbt.txOutputs) {
            const v = this._toU64(out.value);
            if (v === null)
                return this._deny('CANNOT_CHECK_FEE', 'non-numeric or non-integral output value');
            totalOut += v;
        }
        const fee = totalIn - totalOut;
        if (fee < 0n)
            return this._deny('OUTPUTS_EXCEED_INPUTS', { totalIn: totalIn.toString(), totalOut: totalOut.toString() });
        if (totalIn > 0n && totalOut === 0n)
            return this._deny('FEE_BURNS_ENTIRE_INPUT', { totalIn: totalIn.toString(), fee: fee.toString() });
        if (this.maxFeeSats !== null && fee > BigInt(this.maxFeeSats))
            return this._deny('FEE_EXCEEDS_CAP', { fee: fee.toString(), maxFeeSats: this.maxFeeSats });
        return null;
    }

    // Anti-forgery gate: _checkOutputs/_checkFee both trust the caller-supplied
    // witnessUtxo.script/value as ground truth for the account being spent, but
    // never verify it actually IS this daemon's account before _recordBudget
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
    _checkPrevouts(psbt, indices, expectedScript) {
        const expected = expectedScript || this.accountScript;
        for (const idx of indices) {
            const inp = psbt.data.inputs[idx];
            if (!inp || !inp.witnessUtxo || !inp.witnessUtxo.script)
                return this._deny('CANNOT_CHECK_OUTPUTS', 'signed input has no witnessUtxo');
            const got = inp.witnessUtxo.script;
            if (!got.equals(expected))
                return this._deny('PREVOUT_NOT_OUR_ACCOUNT', {
                    index:    idx,
                    expected: expected.toString('hex'),
                    got:      got.toString('hex'),
                });
        }
        return null;
    }

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

        // 1b. Envelope context ( §3.9). Present only when the caller
        //     supplies the envelope SCRIPT; the script is not a trust transfer
        //     the way a raw tweak would be (G3), because this daemon parses it,
        //     matches it against the §3.2 grammar, checks it commits to this
        //     account's own aggregate key, and reads the ACTION it is being
        //     asked to approve straight out of it. The role is DERIVED from the
        //     PSBT, never taken from the request.
        let env = null;
        if (req.envelope) {
            if (this.tweaks.length)
                return this._deny('ENVELOPE_UNSUPPORTED_ACCOUNT',
                    'the envelope surface supports the plain 2-of-2 key-path account only; a 2-of-3 ' +
                    'account would have to compose its recovery leaves with the envelope leaf in one ' +
                    'tap tree, which is a tree-design decision this daemon must not improvise');
            let script;
            try { script = Buffer.isBuffer(req.envelope.script) ? req.envelope.script : Buffer.from(String(req.envelope.script), 'hex'); }
            catch (e) { return this._deny('ENVELOPE_SCRIPT_INVALID', 'envelope.script is not hex'); }
            let commit;
            try {
                commit = deriveEnvelopeCommit({
                    internalXOnly: this.aggregateXOnly, envelopeScript: script, network: this.network || undefined,
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
        const windowUsage = this.windowStore ? this.windowStore.snapshot() : undefined;
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
        const signatures = [];
        const envTweaks = (env && env.role === 'cancel')
            ? [{ tweak: env.commit.tweak, xOnly: true }]
            : this.tweaks;
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
    }

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
    }

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
    }
}

module.exports = CoSigner;
module.exports.taprootKeyPathSighash = taprootKeyPathSighash;
