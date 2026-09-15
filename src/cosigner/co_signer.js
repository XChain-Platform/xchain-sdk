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
const MuSig2  = require('./musig2.js');
const outputPolicy = require('./co_signer/output_policy.js');
const signRequest = require('./co_signer/sign_request.js');
const { exactU64 } = outputPolicy;
const { toBytes, taprootKeyPathSighash } = signRequest;
const { deriveMuSig2P2TR2of3 } = require('./account.js');
const { isCapInert } = require('./value_derivability.js');

// Taproot operations (p2tr derivation, key-path sighash) require an ECC backend.
// initEccLib sets a bitcoinjs global; idempotent and safe to call on module load.
bitcoin.initEccLib(ecc);

// Default ceiling on both the requested and the PSBT-total input count (G14).
// Comfortably above any realistic agent spend, far below the point where the
// quadratic sighash work becomes a denial of service.
const DEFAULT_MAX_COSIGN_INPUTS = 32;

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
        // This daemon's OWN key must be in the signer set, and the set's order is a
        // claim it has to check rather than adopt. Fail closed at construction, the
        // mirror of MuSig2AgentSession's COSIGNER_KEY_MISMATCH on the agent side.
        const ownPub = ecc.pointFromScalar(this.secretKey, true);
        if (!ownPub) throw new Error('secretKey is not a valid secp256k1 private key');
        const ownHex  = Buffer.from(ownPub).toString('hex').toLowerCase();
        const keyHex  = this.publicKeys.map((k, i) =>
            Buffer.from(toBytes(k, 'publicKeys[' + i + ']')).toString('hex').toLowerCase());
        this.ownKeyIndex = keyHex.indexOf(ownHex);
        if (this.ownKeyIndex < 0)
            throw new Error("this co-signer's secretKey does not derive any key in publicKeys, so its "
                + 'partial can never aggregate to the account key (publicKeys is the [agent, daemon] '
                + "pair and must contain this daemon's public key)");
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
            // The 2-of-3 tree is ORDER-SENSITIVE: deriveMuSig2P2TR2of3 builds two
            // ASYMMETRIC leaves, MuSig2(agent,recovery) and MuSig2(daemon,recovery),
            // so the daemon must be publicKeys[1]. The agent half normalizes by
            // searching for its own key (musig2_agent_session.js), so a swapped pair
            // does not collide: it derives a different address and differently
            // composed recovery leaves, and the operator's escape hatch is not
            // where they believe it is. Refuse it here instead.
            if (this.ownKeyIndex !== 1)
                throw new Error('a 2-of-3 co-signer must occupy publicKeys[1]: publicKeys is the '
                    + '[agent, daemon] pair IN THAT ORDER, and the two recovery leaves are derived '
                    + "asymmetrically from it, so a swapped pair commits leaves nobody expects. This "
                    + "daemon's key is at index " + this.ownKeyIndex + '; swap publicKeys.');
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
        // Parsed with exactU64, not Number(). Both enforcement sites
        // below compare in BigInt, so a Number() hop rounded the cap BEFORE it was
        // enforced and the daemon could approve a fee above what the operator set.
        // This is the same parse allowedOutputs[].maxValue already uses; the cap is
        // now a BigInt, so the two _deny details that embed it stringify it.
        this.maxFeeSats = (config.maxFeeSats === undefined || config.maxFeeSats === null)
            ? null : exactU64(config.maxFeeSats);
        if (this.maxFeeSats === null && config.maxFeeSats !== undefined && config.maxFeeSats !== null)
            throw new Error('maxFeeSats must be a non-negative integer (number, bigint, or digit string)');
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
            // The account's OUTPUT key: the bare aggregate on a 2-of-2, the
            // tap-tweaked key on a 2-of-3. What a key-path signature verifies under.
            this.aggregateXOnly = Buffer.from(agg.xOnlyPubkey);
            // The UNTWEAKED cooperative aggregate MuSig2(agent, daemon), which is
            // the envelope commit tree's internal key and its leaf's OP_CHECKSIG
            // key in BOTH account shapes. On a 2-of-2 it is the same
            // bytes as aggregateXOnly; on a 2-of-3 it is the account tap tree's
            // internal key, so a reveal stays a no-tweak session either way.
            this.internalXOnly = Buffer.from(this.musig.aggregateKeys(this.publicKeys, []).xOnlyPubkey);
        } catch (e) {
            throw new Error('failed to derive the account scriptPubKey from the participant keys: ' + e.message);
        }
    }

    _deny(reason, detail) { return { approved: false, reason, detail: detail || null }; }

}

Object.assign(CoSigner.prototype,
    outputPolicy,
    signRequest);

module.exports = Object.assign(CoSigner, {
    taprootKeyPathSighash,
    // Exported rather than copied: exactU64 is what rejects a non-integer or negative
    // satoshi bound, and a duplicated twin is where the Number() rounding this parser
    // exists to prevent creeps back in.
    exactU64,
});
