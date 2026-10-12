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
 * XChain Platform SDK - Wallet Utilities
 *
 * Key management, address validation, PSBT signing, broadcast, UTXOs.
 *
 ********************************************************************/

require('../apply_bufferutils_patch');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { SDKWalletError } = require('../errors.js');
const { ECPair } = require('./key_derivation.js');
const { assertConsistentPrevouts, findVerifiedPrevout } = require('./psbt_prevout.js');

bitcoin.initEccLib(ecc);

module.exports = {
    /**
     * Produce a DER-encoded ECDSA signature over the given 32-byte
     * sighash using the given 32-byte secret key. Used by §22.3
     * P2SH / P2WSH classical multisig signing: each cosigner emits
     * one of these against the input's sighash; the coordinator's
     * PSBT finalizer assembles the threshold-of-N signatures into
     * the witness / redeem-script-input.
     *
     * No sighash flag byte is appended; callers that need one (PSBT
     * v0 inputs typically use SIGHASH_ALL = 0x01) append it
     * themselves so this method stays a thin ECDSA primitive.
     *
     * @param {Uint8Array} msgHash      32 bytes
     * @param {Uint8Array} secretKey    32 bytes
     * @returns {Uint8Array}            DER-encoded signature
     */
    signEcdsa(msgHash, secretKey) {
        if (!(msgHash instanceof Uint8Array) || msgHash.length !== 32) {
            throw new SDKWalletError('INVALID_INPUT', 'signEcdsa: msgHash must be a 32-byte Uint8Array');
        }
        if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
            throw new SDKWalletError('INVALID_INPUT', 'signEcdsa: secretKey must be a 32-byte Uint8Array');
        }
        if (!ecc.isPrivate(secretKey)) {
            throw new SDKWalletError('INVALID_INPUT', 'signEcdsa: secretKey is not a valid secp256k1 scalar');
        }
        const compactSig = ecc.sign(msgHash, secretKey);
        // ecc.sign returns the 64-byte compact (r || s) form. Convert
        // to DER for PSBT-finalizer compatibility; bitcoinjs-lib's
        // PSBT input slot expects DER-encoded signatures.
        return compactToDer(compactSig);
    },

    /**
     * Add this cosigner's partial signatures to a classical (P2SH / P2WSH)
     * multisig PSBT, BUT do NOT finalize. Each cosigner's wallet calls this
     * independently, then the coordinator merges the signed-but-unfinalized
     * PSBTs (the signatures stack under each input's `partialSig` field) and
     * runs `finalizeMultisigPsbt` once threshold is met.
     *
     * Only multisig inputs are signed: an input whose `witnessScript` (or,
     * without one, `redeemScript`) is a bare multisig script listing this
     * key. The coordinator writes the PSBT, so any other input this key can
     * spend, such as a plain single-key UTXO mixed into the spend, is left
     * unsigned. `opts.inputIndices` narrows signing further to the inputs
     * the user approved; every listed input must pass the same check, or
     * the call throws and signs nothing.
     *
     * @param {string} psbtHex
     * @param {string} wif
     * @param {{ inputIndices?: number[] }} [opts]
     * @returns {{ psbtHex: string }}    PSBT with this WIF's partial sigs added
     */
    signMultisigPsbt(psbtHex, wif, opts) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'signMultisigPsbt: PSBT hex is required');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'signMultisigPsbt: WIF is required');
        }
        const net = this.resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKWalletError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }
        let psbt;
        try {
            psbt = bitcoin.Psbt.fromHex(psbtHex, { network: net });
        } catch (err) {
            throw new SDKWalletError('INVALID_PSBT', `Failed to parse PSBT: ${err.message}`);
        }
        // Refuse disagreeing UTXO fields before signing, so this key signs only the prevout every reader sees
        assertConsistentPrevouts(psbt);
        const targets = multisigSigningTargets(psbt, keyPair.publicKey, opts);
        try {
            for (const i of targets) psbt.signInput(i, keyPair);
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `signMultisigPsbt: ${err.message}`);
        }
        return { psbtHex: psbt.toHex() };
    },

    /**
     * Finalize a PSBT that already has every input's signature
     * threshold met. Returns the broadcastable tx hex + txid.
     *
     * @param {string} psbtHex
     * @param {{ maximumFeeRate?: number }} [opts]  maximumFeeRate overrides the
     *   sat/vB extraction ceiling resolveMaxFeeRate resolves from the network.
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    finalizeMultisigPsbt(psbtHex, opts) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'finalizeMultisigPsbt: PSBT hex is required');
        }
        const net = this.resolveNet();
        let psbt;
        try {
            psbt = bitcoin.Psbt.fromHex(psbtHex, { network: net });
        } catch (err) {
            throw new SDKWalletError('INVALID_PSBT', `Failed to parse PSBT: ${err.message}`);
        }
        // Refuse disagreeing UTXO fields, so the extraction fee ceiling reads the prevouts that were signed
        assertConsistentPrevouts(psbt);
        try {
            psbt.finalizeAllInputs();
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `finalizeMultisigPsbt: ${err.message}`);
        }
        // The same ceiling every other extraction path applies (signPsbt,
        // signEnvelopeRevealPsbt, signRevealPsbt, cosigner/musig2Signer). Without
        // it the N-of-M coordinator flow is the one path where a threshold-signed
        // transaction on a low-unit-value chain cannot be extracted at all: an
        // ordinary DOGE fee is ~50k sat/vB and bitcoinjs's default guard is 5000,
        // so the funds are stuck with nothing left to sign.
        const maxFeeRate = this.resolveMaxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();
        return {
            psbtHex: psbt.toHex(),
            txHex: tx.toHex(),
            txid: tx.getId(),
        };
    },
};

/**
 * True when input `index` is a classical multisig input listing `pubkey`:
 * its witnessScript (P2WSH, P2SH-P2WSH) or else its redeemScript (bare
 * P2SH) decodes as a bare multisig script, the only shape
 * deriveMultisigAddress builds, and one of its keys is this key.
 *
 * @param {bitcoin.Psbt} psbt
 * @param {number} index
 * @param {Uint8Array} pubkey
 * @returns {boolean}
 */
function isMultisigInputForKey(psbt, index, pubkey) {
    const input = psbt.data.inputs[index];
    const script = input.witnessScript || input.redeemScript;
    // No script means a single-key input (P2PKH, P2WPKH, taproot key path)
    if (!script) return false;
    // The coordinator supplies these script fields too, so they must hash to the output actually spent
    if (!scriptsCommitToPrevout(psbt, index, input)) return false;
    let pubkeys;
    try {
        pubkeys = bitcoin.payments.p2ms({ output: script }).pubkeys;
    } catch (_) {
        // Any script that is not bare multisig (P2SH-P2WPKH's redeemScript included)
        return false;
    }
    const mine = Buffer.from(pubkey);
    return pubkeys.some((pk) => mine.equals(Buffer.from(pk)));
}

/**
 * True when the input's witnessScript / redeemScript are the scripts its
 * spent output commits to: P2WSH(witnessScript), P2SH(redeemScript), or
 * P2SH(P2WSH(witnessScript)) with both present. bitcoinjs ignores a script
 * field the prevout type does not use and signs the single-key input anyway,
 * so a decoy multisig script on a P2WPKH or P2PKH input must not pass.
 *
 * @param {bitcoin.Psbt} psbt
 * @param {number} index
 * @param {object} input  psbt.data.inputs[index]
 * @returns {boolean}
 */
function scriptsCommitToPrevout(psbt, index, input) {
    const prevout = findVerifiedPrevout(psbt, index);
    // No UTXO data means nothing to bind the scripts to
    if (!prevout) return false;
    const spent = Buffer.from(prevout.script);
    try {
        const p2sh = (output) => Buffer.from(bitcoin.payments.p2sh({ redeem: { output } }).output);
        const p2wsh = (output) => Buffer.from(bitcoin.payments.p2wsh({ redeem: { output } }).output);
        if (input.witnessScript) {
            const wsh = p2wsh(input.witnessScript);
            // P2SH-P2WSH: the redeemScript must be that witness program, and the prevout its P2SH hash
            if (input.redeemScript) return wsh.equals(Buffer.from(input.redeemScript)) && spent.equals(p2sh(input.redeemScript));
            // Native P2WSH: the prevout must be the witness program itself
            return spent.equals(wsh);
        }
        // Bare P2SH: the prevout must be the redeemScript's P2SH hash
        return spent.equals(p2sh(input.redeemScript));
    } catch (_) {
        // A script bitcoinjs cannot wrap commits to nothing
        return false;
    }
}

/**
 * The input indices signMultisigPsbt may sign: the caller's list when one is
 * given (each entry checked), otherwise every multisig input for this key.
 *
 * @param {bitcoin.Psbt} psbt
 * @param {Uint8Array} pubkey
 * @param {{ inputIndices?: number[] }} [opts]
 * @returns {number[]}
 */
function multisigSigningTargets(psbt, pubkey, opts) {
    const listed = (opts && Array.isArray(opts.inputIndices)) ? opts.inputIndices : null;
    if (listed) {
        // An empty list would sign nothing, which a caller never means
        if (listed.length === 0) {
            throw new SDKWalletError('SIGN_FAILED', 'signMultisigPsbt: inputIndices is empty');
        }
        for (const i of listed) {
            // Each entry must name an input that exists
            if (!Number.isInteger(i) || i < 0 || i >= psbt.inputCount) {
                throw new SDKWalletError('INVALID_INPUT', `signMultisigPsbt: inputIndices entry ${JSON.stringify(i)} is not an input of this PSBT`);
            }
            // A listed input must still be a multisig input for this key; it is refused, never skipped
            if (!isMultisigInputForKey(psbt, i, pubkey)) {
                throw new SDKWalletError('SIGN_FAILED', `signMultisigPsbt: input #${i} is not a multisig input for this key`);
            }
        }
        return listed;
    }
    const targets = [];
    for (let i = 0; i < psbt.inputCount; i++) {
        if (isMultisigInputForKey(psbt, i, pubkey)) targets.push(i);
    }
    // Nothing to sign means this is not this cosigner's multisig spend
    if (targets.length === 0) {
        throw new SDKWalletError('SIGN_FAILED', 'signMultisigPsbt: no multisig input in this PSBT lists this key');
    }
    return targets;
}

/**
 * Convert a 64-byte (r||s) compact ECDSA signature to DER. Used by
 * `WalletUtils.signEcdsa` so callers get the form bitcoinjs-lib's
 * PSBT-input slot expects.
 *
 * @param {Uint8Array} compact   64 bytes
 * @returns {Uint8Array}
 */
function compactToDer(compact) {
    const r = trimLeading(compact.subarray(0, 32));
    const s = trimLeading(compact.subarray(32, 64));
    const inner = new Uint8Array(2 + r.length + 2 + s.length);
    let off = 0;
    inner[off++] = 0x02;
    inner[off++] = r.length;
    inner.set(r, off); off += r.length;
    inner[off++] = 0x02;
    inner[off++] = s.length;
    inner.set(s, off);
    const out = new Uint8Array(2 + inner.length);
    out[0] = 0x30;
    out[1] = inner.length;
    out.set(inner, 2);
    return out;
}

function trimLeading(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0x00 && (bytes[i + 1] & 0x80) === 0) i++;
    const trimmed = bytes.subarray(i);
    // BIP-66 requires the high bit of the first byte to be 0; if it
    // would be 1, prepend a 0x00 so the integer stays positive in DER.
    if (trimmed[0] & 0x80) {
        const padded = new Uint8Array(trimmed.length + 1);
        padded[0] = 0x00;
        padded.set(trimmed, 1);
        return padded;
    }
    return trimmed;
}

Object.defineProperties(module.exports, {
    compactToDer: { value: compactToDer },
    trimLeading: { value: trimLeading },
});
