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
const constructorSetup = require('./co_signer/constructor_setup.js');
const { exactU64 } = outputPolicy;
const { taprootKeyPathSighash } = signRequest;
const { installMethods } = require('../utils/install_methods.js');

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
        constructorSetup.setIdentity(this, config);
        constructorSetup.validateActionCaps(config);
        constructorSetup.setTapTree(this, config);
        this.allowConfirmable = config.allowConfirmable === true;
        // Operator-authorized non-change outputs (COINPAY native legs, the
        // protocol-fee output). Everything NOT in this set, change-to-self, or the
        // OP_RETURN carrier is treated as a drain and refused (see _checkOutputs).
        this.allowedOutputs = this._normalizeAllowedOutputs(config.allowedOutputs || []);
        constructorSetup.setLimits(this, config, DEFAULT_MAX_COSIGN_INPUTS);
        this.musig = new MuSig2();
        constructorSetup.setAccount(this);
    }

    _deny(reason, detail) { return { approved: false, reason, detail: detail || null }; }

}

installMethods(CoSigner.prototype,
    outputPolicy,
    signRequest);

module.exports = Object.assign(CoSigner, {
    taprootKeyPathSighash,
    // Exported rather than copied: exactU64 is what rejects a non-integer or negative
    // satoshi bound, and a duplicated twin is where the Number() rounding this parser
    // exists to prevent creeps back in.
    exactU64,
});
