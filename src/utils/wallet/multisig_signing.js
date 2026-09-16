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
     * Sign every input of a PSBT with a WIF, BUT do NOT finalize. Used
     * by xchain-wallet's classical (P2SH / P2WSH) multisig flow: each
     * cosigner's wallet calls this independently, then the coordinator
     * merges the resulting signed-but-unfinalized PSBTs together (the
     * signatures stack under each input's `partialSig` field) and runs
     * `finalizeMultisigPsbt` once threshold is met.
     *
     * For inputs that carry a `redeemScript` (P2SH) or `witnessScript`
     * (P2WSH), bitcoinjs-lib's `signAllInputs` correctly emits a partial
     * signature against the script's matching pubkey rather than trying
     * to assemble a single-sig witness.
     *
     * @param {string} psbtHex
     * @param {string} wif
     * @returns {{ psbtHex: string }}    PSBT with this WIF's partial sigs added
     */
    signMultisigPsbt(psbtHex, wif) {
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
        try {
            psbt.signAllInputs(keyPair);
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
