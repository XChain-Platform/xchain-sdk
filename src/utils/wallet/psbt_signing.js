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
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils');
const ecc = require('@bitcoinerlab/secp256k1');
const { SDKWalletError } = require('../errors.js');
const { ECPair } = require('./key_derivation.js');
const { assertConsistentPrevouts, findVerifiedPrevout } = require('./psbt_prevout.js');

bitcoin.initEccLib(ecc);

// Honest maximum fee rate (sat/vB) the encoder will build for each chain, plus
// 2x headroom for the vsize estimate drifting from the final witness size.
// Derived from the encoder's per-chain MAX_FEE_RATE_KB cap (sat/kB / 1000):
// dogecoin 10 DOGE/kB = 1e6 sat/vB, litecoin 1 LTC/kB = 1e5 sat/vB.
const ENCODER_MAX_FEE_RATE_SAT_VB = { dogecoin: 1000000, litecoin: 100000 };
const CEILING_HEADROOM = 2;
const UNKNOWN_CHAIN_CEILING = 10000000;

// supplyNested fills in the redeem script of this key's own P2SH-P2WPKH inputs.
function createSigningContext(psbtHex, wif, net, supplyNested) {
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
    // Refuse disagreeing UTXO fields before signing, so the fee ceiling and any gate read the prevout the key signs
    assertConsistentPrevouts(psbt);
    if (supplyNested) supplyNestedRedeemScripts(psbt, keyPair, net);

    return { keyPair, psbt };
}

// Supply the redeem script of each P2SH-P2WPKH input this key controls when the PSBT
// leaves it out: it is the key's own P2WPKH script, and without it no input of that
// shape can be signed. Inputs paying any other script are left as they are.
function supplyNestedRedeemScripts(psbt, keyPair, net) {
    // Skip a network without segwit (`=== false`: native bitcoinjs networks lack the field)
    if (net && net.supportsSegwit === false) return;
    let redeem, wrapped;
    try {
        redeem  = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyPair.publicKey), network: net }).output;
        wrapped = bitcoin.payments.p2sh({ redeem: { output: redeem }, network: net }).output;
    } catch (e) {
        return; // an uncompressed key has no P2WPKH script
    }
    psbt.data.inputs.forEach((input, i) => {
        if (input.redeemScript || input.finalScriptSig || input.finalScriptWitness) return;
        let prevout = null;
        try { prevout = findVerifiedPrevout(psbt, i); } catch (e) { prevout = null; }
        if (prevout && prevout.script && Buffer.from(prevout.script).equals(wrapped))
            psbt.updateInput(i, { redeemScript: redeem });
    });
}

// Match a BIP141 witness program: OP_0 or OP_1..OP_16, then one push of 2 to 40 bytes.
function isWitnessProgram(script) {
    if (!script || script.length < 4 || script.length > 42) return false;
    const b = Buffer.from(script);
    return (b[0] === 0x00 || (b[0] >= 0x51 && b[0] <= 0x60)) && b[1] === b.length - 2;
}

// Name the PSBT fields that mark a taproot input.
const TAPROOT_INPUT_FIELDS = ['tapInternalKey', 'tapKeySig', 'tapScriptSig', 'tapLeafScript', 'tapMerkleRoot'];

// Detect an input bitcoinjs would sign with a witness (segwit v0 or taproot).
function isWitnessSpend(psbt, i) {
    const input = psbt.data.inputs[i];
    if (!input) return false;
    if (input.witnessScript || input.finalScriptWitness) return true;
    if (TAPROOT_INPUT_FIELDS.some((k) => input[k] !== undefined)) return true;
    if (isWitnessProgram(input.redeemScript)) return true;
    const prevout = findVerifiedPrevout(psbt, i);
    return !!(prevout && isWitnessProgram(prevout.script));
}

// Return the explicit input set of a scoped sign, or null to sign every input; refuse an empty set.
function scopedInputIndices(opts) {
    const scoped = (opts && Array.isArray(opts.inputIndices)) ? opts.inputIndices : null;
    if (scoped && scoped.length === 0) {
        throw new SDKWalletError('SIGN_FAILED', 'PSBT signing failed: inputIndices is empty');
    }
    return scoped;
}

// Refuse a witness spend among the inputs about to be signed on a network without
// segwit, where the program is anyone-can-spend and a witness transaction does not relay.
function assertNoWitnessSpends(psbt, net, indices, networkName) {
    if (!net || net.supportsSegwit !== false) return;
    for (const i of indices) {
        if (isWitnessSpend(psbt, i))
            throw new SDKWalletError('SEGWIT_NOT_SUPPORTED',
                `SegWit inputs are not supported on ${networkName} (input #${i}).`);
    }
}

module.exports = {
    /**
     * Resolve the fee ceiling (sat/vB) applied before extractTransaction.
     * bitcoinjs-lib's "absurd fee" guard defaults to 5000 sat/vB, calibrated
     * for BTC's unit value. On chains whose base unit is worth far less, an
     * ordinary fee blows past it (DOGE: a normal ~0.5 DOGE/kB estimator rate
     * is ~50k sat/vB), rejecting every transaction at signing. Litecoin and
     * dogecoin therefore get a ceiling derived from the encoder's honest
     * maximum fee rate (with headroom), so a runaway fee is still refused;
     * any other non-bitcoin network keeps a flat 10,000,000 ceiling.
     * Callers can override in either direction via opts.maximumFeeRate.
     *
     * @param {{ maximumFeeRate?: number }} [opts]
     * @returns {number|null} sat/vB ceiling, or null to keep bitcoinjs's default
     */
    resolveMaxFeeRate(opts) {
        if (opts && Number.isFinite(opts.maximumFeeRate) && opts.maximumFeeRate > 0)
            return opts.maximumFeeRate;
        const chain = String(this.network || '').split('-')[0];
        if (chain === 'bitcoin') return null;
        const honest = ENCODER_MAX_FEE_RATE_SAT_VB[chain];
        return honest ? honest * CEILING_HEADROOM : UNKNOWN_CHAIN_CEILING;
    },

    /**
     * Sign an unsigned PSBT hex string with a WIF private key.
     *
     * By default every input the key can sign is signed and finalized. When
     * `opts.inputIndices` is supplied, ONLY those inputs are signed/finalized;
     * this is how the wallet restricts a dApp-supplied PSBT to the exact inputs
     * the user was shown/approved, instead of blindly signing every UTXO the
     * active key controls. With a partial (scoped) sign the transaction is not
     * fully finalized, so the extracted tx is omitted and the partially-signed
     * PSBT is returned for the caller/counterparty to complete.
     *
     * @param {string} psbtHex - Unsigned PSBT from encoder, as hex
     * @param {string} wif - WIF-encoded private key
     * @param {{ maximumFeeRate?: number, inputIndices?: number[] }} [opts] - sat/vB
     *   fee ceiling override and/or the explicit set of input indices to sign
     * @returns {{ txHex: (string|null), txid: (string|null), psbtHex: string }}
     */
    signPsbt(psbtHex, wif, opts) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'PSBT hex string is required.');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'WIF private key is required.');
        }

        const net = this.resolveNet();
        const { keyPair, psbt } = createSigningContext(psbtHex, wif, net, true);

        // Scoped signing: when an explicit input set is given, sign/finalize ONLY
        // those inputs. Any other input the key happens to control (e.g. a UTXO a
        // crafted PSBT mixed in that the user never approved) is left untouched.
        const scoped = scopedInputIndices(opts);
        assertNoWitnessSpends(psbt, net, scoped || psbt.data.inputs.map((_, i) => i), this.network);

        try {
            if (scoped) {
                for (const i of scoped) psbt.signInput(i, keyPair);
            } else {
                psbt.signAllInputs(keyPair);
            }
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `PSBT signing failed: ${err.message}`);
        }

        try {
            if (scoped) {
                for (const i of scoped) psbt.finalizeInput(i);
            } else {
                psbt.finalizeAllInputs();
            }
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `PSBT finalization failed: ${err.message}`);
        }

        // Only extract a broadcastable tx when EVERY input is finalized. A scoped
        // partial sign deliberately leaves unapproved inputs unfinalized, so the tx
        // is incomplete; return the partially-signed PSBT rather than throwing or
        // emitting a half-finalized extraction.
        const allFinalized = psbt.data.inputs.every(
            (inp) => inp.finalScriptSig || inp.finalScriptWitness
        );
        if (!allFinalized) {
            return { txHex: null, txid: null, psbtHex: psbt.toHex() };
        }

        const maxFeeRate = this.resolveMaxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();

        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex()
        };
    },

    /**
     * Build a finalizer for XChain P2SH / P2WSH "reveal" inputs (the phase-2
     * transaction of the two-step large-action encoding. Each such input
     * spends a data-carrying P2SH/P2WSH output created by phase 1, so its
     * redeem/witness script is the non-standard XChain payload script and
     * bitcoinjs-lib's default finalizer cannot assemble it. We compile the
     * scriptSig / witness from the single partial signature + pubkey, wrapped
     * in the matching p2sh/p2wsh payment. Mirrors xchain-e2e-test's
     * transactionHelper.xchainP2shFinalizer, but network-aware.
     *
     * @param {object} net  bitcoinjs network params
     */
    xchainRevealFinalizer(net) {
        return (inputIndex, input, script, isSegwit, isP2SH, isP2WSH) => {
            if (!input.partialSig || !input.partialSig[0]) {
                throw new SDKWalletError('FINALIZE_FAILED',
                    'reveal finalizer: input #' + inputIndex + ' has no partial signature');
            }
            const sig = bitcoin.script.compile([
                input.partialSig[0].signature,
                input.partialSig[0].pubkey,
            ]);
            if (isP2SH) {
                const payment = bitcoin.payments.p2sh({
                    network: net,
                    redeem: { network: net, input: sig, output: script },
                });
                return { finalScriptSig: payment.input, finalScriptWitness: undefined };
            }
            if (isP2WSH) {
                const payment = bitcoin.payments.p2wsh({
                    network: net,
                    redeem: { network: net, input: sig, output: script },
                });
                return {
                    finalScriptSig: undefined,
                    finalScriptWitness: psbtutils.witnessStackToScriptWitness(payment.witness),
                };
            }
            throw new SDKWalletError('FINALIZE_FAILED',
                'reveal finalizer: input #' + inputIndex + ' is neither P2SH nor P2WSH');
        };
    },

    /**
     * Sign the REVEAL half of a Taproot envelope pair (envelope spec §3.2/§3.5).
     *
     * Distinct from signRevealPsbt, which signs a P2SH/P2WSH chunk reveal with
     * ECDSA and the xchain reveal finalizer. An envelope reveal is a BIP341
     * script-path spend: it needs a Schnorr signature over the tapleaf and the
     * standard taproot finalizer, so neither the key nor the finalizer from that
     * path applies here.
     *
     * Signs input 0 only, because §3.5 pins the commit outpoint at input 0 and
     * declares any additional reveal input the caller's own business; signing them
     * with this key would be wrong whenever they are not this key's.
     *
     * @param {string} psbtHex - the revealPsbt hex returned alongside the commit
     * @param {string} wif
     * @param {{ maximumFeeRate?: number }} [opts] - sat/vB fee ceiling override
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    signEnvelopeRevealPsbt(psbtHex, wif, opts) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'PSBT hex string is required.');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'WIF private key is required.');
        }

        const net = this.resolveNet();
        const { keyPair, psbt } = createSigningContext(psbtHex, wif, net);

        try {
            psbt.signInput(0, {
                publicKey: Buffer.from(keyPair.publicKey),
                signSchnorr: (hash) => Buffer.from(ecc.signSchnorr(hash, keyPair.privateKey)),
            });
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `Envelope reveal signing failed: ${err.message}`);
        }

        try {
            psbt.finalizeInput(0);
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `Envelope reveal finalization failed: ${err.message}`);
        }

        const maxFeeRate = this.resolveMaxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        let tx;
        try {
            tx = psbt.extractTransaction();
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `Envelope reveal finalization failed: ${err.message}`);
        }
        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex(),
        };
    },

    /**
     * Sign + finalize a P2SH/P2WSH reveal PSBT (phase 2 of large-action
     * encoding). Every input is a data-carrying reveal input, so each is
     * finalized with the custom XChain finalizer rather than the default.
     *
     * @param {string} psbtHex - phase-2 PSBT hex from encoder.spendP2sh
     * @param {string} wif
     * @param {{ maximumFeeRate?: number }} [opts] - sat/vB fee ceiling override
     * @returns {{ txHex: string, txid: string, psbtHex: string }}
     */
    signRevealPsbt(psbtHex, wif, opts) {
        if (!psbtHex || typeof psbtHex !== 'string') {
            throw new SDKWalletError('INVALID_PSBT', 'PSBT hex string is required.');
        }
        if (!wif || typeof wif !== 'string') {
            throw new SDKWalletError('INVALID_WIF', 'WIF private key is required.');
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
        // Refuse disagreeing UTXO fields before signing (see createSigningContext)
        assertConsistentPrevouts(psbt);

        try {
            psbt.signAllInputs(keyPair);
        } catch (err) {
            throw new SDKWalletError('SIGN_FAILED', `PSBT signing failed: ${err.message}`);
        }

        const finalizer = this.xchainRevealFinalizer(net);
        try {
            for (let i = 0; i < psbt.data.inputs.length; i += 1) {
                psbt.finalizeInput(i, finalizer);
            }
        } catch (err) {
            throw new SDKWalletError('FINALIZE_FAILED', `Reveal PSBT finalization failed: ${err.message}`);
        }

        const maxFeeRate = this.resolveMaxFeeRate(opts);
        if (maxFeeRate) psbt.setMaximumFeeRate(maxFeeRate);
        const tx = psbt.extractTransaction();
        return {
            txHex: tx.toHex(),
            txid: tx.getId(),
            psbtHex: psbt.toHex(),
        };
    },
};
