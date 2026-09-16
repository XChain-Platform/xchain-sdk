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
 * XChain Platform SDK - Co-Signer Constructor Setup
 *
 ********************************************************************/

'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { deriveMuSig2P2TR2of3 } = require('../account.js');
const { isCapInert } = require('../policy/value_derivability.js');
const { exactU64 } = require('./output_policy.js');
const { toBytes } = require('./sign_request.js');

// Set identity and policy fields together to preserve constructor validation order.
function setIdentity(self, config) {
    self.secretKey  = toBytes(config.secretKey, 'secretKey');
    if (self.secretKey.length !== 32) throw new Error('secretKey must be 32 bytes');
    // EXACTLY two: the daemon returns ONE partial and the agent aggregates it
    // with its own, so a larger set funds an address the cooperative path can
    // never spend. The 2-of-3 account names its third key as recoveryPublicKey.
    if (!Array.isArray(config.publicKeys) || config.publicKeys.length !== 2)
        throw new Error('publicKeys must be exactly the [agent, daemon] pair '
            + '(a 2-of-3 account names its third key as recoveryPublicKey)');
    self.publicKeys = config.publicKeys;
    // This daemon's OWN key must be in the signer set, and the set's order is a
    // claim it has to check rather than adopt. Fail closed at construction, the
    // mirror of MuSig2AgentSession's COSIGNER_KEY_MISMATCH on the agent side.
    const ownPub = ecc.pointFromScalar(self.secretKey, true);
    if (!ownPub) throw new Error('secretKey is not a valid secp256k1 private key');
    const ownHex  = Buffer.from(ownPub).toString('hex').toLowerCase();
    const keyHex  = self.publicKeys.map((k, i) =>
        Buffer.from(toBytes(k, 'publicKeys[' + i + ']')).toString('hex').toLowerCase());
    self.ownKeyIndex = keyHex.indexOf(ownHex);
    if (self.ownKeyIndex < 0)
        throw new Error("this co-signer's secretKey does not derive any key in publicKeys, so its "
            + 'partial can never aggregate to the account key (publicKeys is the [agent, daemon] '
            + "pair and must contain this daemon's public key)");
    if (!config.policy || !config.policy.allowedActions)
        throw new Error('a normalized policy with allowedActions is required');
    self.policy = config.policy;
    if (self.policy.maxPerWindow && !config.windowStore)
        throw new Error('policy.maxPerWindow requires a windowStore (server-side budget)');
    self.windowStore = config.windowStore || null;
    self.network = config.network || null;
}

// G2: an amount cap keyed on an action whose every decodable format
// defines its value by ACTION_INDEX reference can never fire - the
// daemon cannot read the referenced object, so the amount is always
// undefined and every amount gate skips. Left alone that is a policy the
// operator believes is enforced and which is in fact decorative. Reject
// it here, at construction, rather than at sign time.
// maxPerAction is the only policy table keyed by ACTION (maxPerWindow.perTick
// and confirmAbove.perTick are keyed by tick), so it is the only place an
// action name can be written into an amount limit.
// Reject unenforceable action caps during construction so policy intent stays binding.
function validateActionCaps(config) {
    if (config.policy.maxPerAction) {
        for (const action of Object.keys(config.policy.maxPerAction))
            if (isCapInert(action))
                throw new Error(`policy.maxPerAction.${action} can never bind: every decodable ` +
                    `${action} format defines its value by reference to an on-chain object the ` +
                    `co-signer cannot read, so the cap would be silently inert. Remove the cap ` +
                    `(the output gate + maxFeeSats bound ${action}), or disallow the action.`);
    }
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
// Derive taproot state from participant keys so no opaque tweak enters configuration.
function setTapTree(self, config) {
    if (config.tweaks !== undefined && !(Array.isArray(config.tweaks) && config.tweaks.length === 0))
        throw new Error('config.tweaks is not accepted: a supplied taproot tweak is an unverifiable ' +
            'commitment to an arbitrary script tree (an agent-chosen tree grants the agent a ' +
            'unilateral script-path spend). Configure a 2-of-3 account with recoveryPublicKey ' +
            'instead, and the daemon derives the tree itself.');

    self.recoveryPublicKey = config.recoveryPublicKey || null;
    if (self.recoveryPublicKey) {
        if (self.publicKeys.length !== 2)
            throw new Error('recoveryPublicKey requires exactly the [agent, daemon] pair in publicKeys ' +
                '(the recovery key is the third party and is named separately)');
        // The 2-of-3 tree is ORDER-SENSITIVE: deriveMuSig2P2TR2of3 builds two
        // ASYMMETRIC leaves, MuSig2(agent,recovery) and MuSig2(daemon,recovery),
        // so the daemon must be publicKeys[1]. The agent half normalizes by
        // searching for its own key (musig2_agent_session.js), so a swapped pair
        // does not collide: it derives a different address and differently
        // composed recovery leaves, and the operator's escape hatch is not
        // where they believe it is. Refuse it here instead.
        if (self.ownKeyIndex !== 1)
            throw new Error('a 2-of-3 co-signer must occupy publicKeys[1]: publicKeys is the '
                + '[agent, daemon] pair IN THAT ORDER, and the two recovery leaves are derived '
                + "asymmetrically from it, so a swapped pair commits leaves nobody expects. This "
                + "daemon's key is at index " + self.ownKeyIndex + '; swap publicKeys.');
        let tree;
        try {
            tree = deriveMuSig2P2TR2of3({
                agent:    self.publicKeys[0],
                daemon:   self.publicKeys[1],
                recovery: self.recoveryPublicKey,
            }, self.network || undefined);
        } catch (e) {
            throw new Error('failed to derive the 2-of-3 tap tree from publicKeys/recoveryPublicKey: ' + e.message);
        }
        self.tweaks = tree.keyPath.tweaks;
        self.tapTree = tree;
    } else {
        // Plain 2-of-2: the BIP-327 aggregate IS the taproot output key, with
        // no tweak. That is hidden-leaf-safe by construction - producing a
        // valid control block against an untweaked output key would need a
        // discrete-log relation - precisely because the output key is a key
        // aggregate with key coefficients no single participant can steer.
        self.tweaks = [];
        self.tapTree = null;
    }
}

// Anti-burn fee reconciliation (see checkFee). maxFeeSats is an optional
// operator-set absolute cap (satoshis). It is the only bound that can
// safely be tightened past the always-on guards, because a legitimate fee
// fraction is chain-specific (a low-unit-value chain can pay ~all of a
// small input as fee), so no proportional default can tell a legitimate
// high fee from a drain without operator knowledge.
// Parsed with exactU64, not Number(). Both enforcement sites
// below compare in BigInt, so a Number() hop rounded the cap BEFORE it was
// enforced and the daemon could approve a fee above what the operator set.
// This is the same parse allowedOutputs[].maxValue already uses; the cap is
// now a BigInt, so the two deny details that embed it stringify it.
// G14: the body-size limit bounds BYTES, not WORK. Sighash derivation
// re-copies every prevout script and value per signed input, so the cost is
// quadratic in the PSBT's input count, plus one deterministicSign each. A
// single crafted request could occupy the single-threaded sidecar for
// seconds and a modest stream of them is a sustained freeze - which, per the
// threat model, is permanently stuck funds on a plain 2-of-2. Cap both the
// requested count and the PSBT's TOTAL input count, since the sighash walks
// every input whether or not we sign it.
// Parse numeric limits before signer creation so invalid configuration fails early.
function setLimits(self, config, defaultMaxCosignInputs) {
    self.maxFeeSats = (config.maxFeeSats === undefined || config.maxFeeSats === null)
        ? null : exactU64(config.maxFeeSats);
    if (self.maxFeeSats === null && config.maxFeeSats !== undefined && config.maxFeeSats !== null)
        throw new Error('maxFeeSats must be a non-negative integer (number, bigint, or digit string)');
    self.maxCosignInputs = (config.maxCosignInputs === undefined || config.maxCosignInputs === null)
        ? defaultMaxCosignInputs : Number(config.maxCosignInputs);
    if (!Number.isInteger(self.maxCosignInputs) || self.maxCosignInputs < 1)
        throw new Error('maxCosignInputs must be a positive integer');
}

// The account scriptPubKey this daemon actually spends from, derived ONLY
// from the participant keys, never trusted from a caller-supplied
// witnessUtxo.script (see checkPrevouts). Covers both the plain 2-of-2 key
// path (no tweak) and the tweaked 2-of-3 cooperative key path, whose tweak
// this constructor derived above from the three participant keys.
//
// There is deliberately no `accountScript` config override. It had no
// consumer, its only effect was to WEAKEN the prevout gate (the one gate
// that proves the inputs being signed really belong to this account), and
// the best case for a wrong value was a liveness break. Tests derive the
// script exactly as production does.
// Derive account keys after signer creation so instance field order remains stable.
function setAccount(self) {
    try {
        const agg = self.musig.aggregateKeys(self.publicKeys, self.tweaks);
        const p2tr = bitcoin.payments.p2tr({
            pubkey:  Buffer.from(agg.xOnlyPubkey),
            network: self.network || undefined,
        });
        self.accountScript = p2tr.output;
        // The account's OUTPUT key: the bare aggregate on a 2-of-2, the
        // tap-tweaked key on a 2-of-3. What a key-path signature verifies under.
        self.aggregateXOnly = Buffer.from(agg.xOnlyPubkey);
        // The UNTWEAKED cooperative aggregate MuSig2(agent, daemon), which is
        // the envelope commit tree's internal key and its leaf's OP_CHECKSIG
        // key in BOTH account shapes. On a 2-of-2 it is the same
        // bytes as aggregateXOnly; on a 2-of-3 it is the account tap tree's
        // internal key, so a reveal stays a no-tweak session either way.
        self.internalXOnly = Buffer.from(self.musig.aggregateKeys(self.publicKeys, []).xOnlyPubkey);
    } catch (e) {
        throw new Error('failed to derive the account scriptPubKey from the participant keys: ' + e.message);
    }
}

module.exports = { setIdentity, validateActionCaps, setTapTree, setLimits, setAccount };
