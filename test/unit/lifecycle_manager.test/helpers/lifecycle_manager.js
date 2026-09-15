// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// Helpers: minimal fake SDK and collaborators

// A valid signed P2WPKH tx hex that bitcoinjs-lib can parse (so
// _extractSpentInputs works without a real PSBT). We build it using
// bitcoinjs-lib itself so the bytes are structurally correct.
let _cachedPsbtHex = null;
function buildTestPsbtHex() {
    if (_cachedPsbtHex) return _cachedPsbtHex;
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);

    const net = bitcoin.networks.regtest;
    const kp = ECPair.makeRandom({ network: net });
    const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;

    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(inputScript, 100_000);

    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({
        hash:        prevTx.getId(),
        index:       0,
        sequence:    0xfffffffd,
        witnessUtxo: { script: inputScript, value: 100_000 },
    });
    psbt.addOutput({ script: inputScript, value: 90_000 });
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    _cachedPsbtHex = psbt.toHex();
    return _cachedPsbtHex;
}

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

function buildSignedTx() {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);
    const net = bitcoin.networks.regtest;
    const kp = ECPair.makeRandom({ network: net });
    const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(inputScript, 100_000);
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 100_000 } });
    psbt.addOutput({ script: inputScript, value: 90_000 });
    // The encoder answers UNSIGNED, and reconcileEncoded no longer reads a PRE-SIGNED
    // input's script as a signer-owned change destination, so the mock has
    // to hand back the pre-signature hex. The signing below exists only to produce a
    // broadcastable txHex/txid for the broadcast mock.
    const unsignedHex = psbt.toHex();
    psbt.signAllInputs(kp);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { psbtHex: unsignedHex, txHex: tx.toHex(), txid: tx.getId() };
}

/**
 * A two-transaction chain built with real keys, for the change-tracking tests.
 *
 * tx1 carries an OP_RETURN data output plus change back to `changeAddress` at
 * vout 1; tx2 SPENDS that change output and pays its own change back. This is
 * the shape the P2SH two-phase flow produces, where the reveal consumes what
 * the funding transaction paid the caller.
 *
 * Everything is on the bitcoinjs DEFAULT network, because the fake SDK has no
 * wallet.getBitcoinNetwork and _reconcileNetwork therefore falls back to it.
 */
function buildChangeChain() {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const ECPair = ECPairFactory(ecc);

    const kp        = ECPair.makeRandom();
    const inScript  = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).output;
    const change    = bitcoin.payments.p2pkh({ pubkey: kp.publicKey });
    const opReturn  = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]);

    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(inScript, 100_000);

    const psbt1 = new bitcoin.Psbt();
    psbt1.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd,
                     witnessUtxo: { script: inScript, value: 100_000 } });
    psbt1.addOutput({ script: opReturn, value: 0 });
    psbt1.addOutput({ address: change.address, value: 90_000 });
    const psbt1Hex = psbt1.toHex();          // the encoder answers UNSIGNED
    psbt1.signAllInputs(kp);
    psbt1.finalizeAllInputs();
    const tx1 = psbt1.extractTransaction();

    const psbt2 = new bitcoin.Psbt();
    psbt2.addInput({ hash: tx1.getId(), index: 1, sequence: 0xfffffffd, nonWitnessUtxo: tx1.toBuffer() });
    psbt2.addOutput({ address: change.address, value: 80_000 });
    const psbt2Hex = psbt2.toHex();
    psbt2.signAllInputs(kp);
    psbt2.finalizeAllInputs();
    const tx2 = psbt2.extractTransaction();

    return {
        changeAddress: change.address,
        changeScript:  change.output.toString('hex'),
        // The same key as a raw hex pubkey. The reconcile gate derives the
        // caller's default-type scripts from it, so a change output still
        // reconciles; _extractChangeOutputs cannot parse it as an address.
        pubkeyHex:     Buffer.from(kp.publicKey).toString('hex'),
        phase1: { psbtHex: psbt1Hex, txHex: tx1.toHex(), txid: tx1.getId() },
        phase2: { psbtHex: psbt2Hex, txHex: tx2.toHex(), txid: tx2.getId() },
    };
}

/**
 * Build a minimal fake SDK.
 *
 * @param {Object} [overrides]  – override specific sdk methods
 * @param {Object} [encoderOverrides] – override encoder methods
 */
function makeSdk(overrides = {}, encoderOverrides = {}) {
    const signed = buildSignedTx();

    const defaultEncoder = {
        createTx:    async () => ({ psbt: signed.psbtHex, encoding: 'OP_RETURN' }),
        broadcastTx: async () => ({ txid: signed.txid }),
        spendP2sh:   async () => ({ psbt: signed.psbtHex }),
    };
    const encoder = Object.assign({}, defaultEncoder, encoderOverrides);

    const defaultSdk = {
        _requireEncoder: () => encoder,
        actions: {
            createAction: () => ({
                actionString: 'XCHAIN|SEND|...',
                action:       'SEND',
                version:      1,
            }),
        },
        // Ticker + address compaction run before createAction; pass params through.
        tickResolver: {
            resolveActionParams: async (action, params) => params,
        },
        addressResolver: {
            resolveActionParams: async (action, params) => params,
        },
        wallet: {
            signPsbt:       () => ({ txHex: signed.txHex, txid: signed.txid, psbtHex: signed.psbtHex }),
            signRevealPsbt: () => ({ txHex: signed.txHex, txid: 'phase2txid', psbtHex: signed.psbtHex }),
        },
    };

    return Object.assign({}, defaultSdk, overrides);
}

module.exports = {
    FAKE_WIF,
    buildChangeChain,
    buildSignedTx,
    buildTestPsbtHex,
    makeSdk,
};
