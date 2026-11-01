// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// On a network without segwit (every dogecoin-* network) the PSBT signer adds no
// redeem script and makes no witness signature: a witness program there is
// anyone-can-spend and a witness transaction does not relay.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

const DOGE = 'dogecoin-regtest';
const VALUE = 100000000;

function p2wpkhScript(kp) {
    return bitcoin.script.compile([bitcoin.opcodes.OP_0, bitcoin.crypto.hash160(Buffer.from(kp.publicKey))]);
}

// A previous transaction paying `script`, so the input arrives in the legacy shape.
function prevPaying(script, tag) {
    const prev = new bitcoin.Transaction();
    prev.addInput(Buffer.alloc(32, tag), 0);
    prev.addOutput(script, VALUE);
    return prev;
}

function legacyInput(script, tag, extra) {
    const prev = prevPaying(script, tag);
    return Object.assign({ hash: prev.getId(), index: 0, nonWitnessUtxo: prev.toBuffer() }, extra || {});
}

function dogeFixture() {
    const wallet = new WalletUtils(DOGE);
    const net = getNetwork(DOGE);
    const kp = wallet.generateKeyPair();
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: Buffer.from(kp.publicKey), network: net }).output;
    const nested = bitcoin.payments.p2sh({ redeem: { output: p2wpkhScript(kp) }, network: net }).output;
    return { wallet, net, kp, p2pkh, nested };
}

function psbtOf(net, inputs, outScript) {
    const psbt = new bitcoin.Psbt({ network: net });
    for (const input of inputs) psbt.addInput(input);
    psbt.addOutput({ script: outScript, value: VALUE - 1000000 });
    return psbt.toHex();
}

describe('signing PSBTs on a network without segwit', function () {

    it('adds no redeem script to a nested segwit input outside a scoped DOGE sign', function () {
        const { wallet, net, kp, p2pkh, nested } = dogeFixture();
        const hex = psbtOf(net, [legacyInput(p2pkh, 1), legacyInput(nested, 2)], p2pkh);
        const signed = wallet.signPsbt(hex, kp.wif, { inputIndices: [0] });
        const out = bitcoin.Psbt.fromHex(signed.psbtHex, { network: net });
        expect(out.data.inputs[0].finalScriptSig).to.not.equal(undefined);
        expect(out.data.inputs[1].redeemScript).to.equal(undefined);
        expect(out.data.inputs[1].partialSig).to.equal(undefined);
        expect(out.data.inputs[1].finalScriptWitness).to.equal(undefined);
    });

    it('refuses rather than witness-signs a DOGE input paying the key nested segwit address', function () {
        const { wallet, net, kp, p2pkh, nested } = dogeFixture();
        const hex = psbtOf(net, [legacyInput(nested, 2)], p2pkh);
        expect(() => wallet.signPsbt(hex, kp.wif)).to.throw(/No inputs were signed/);
    });

    it('refuses a DOGE input that brings its own P2WPKH redeem script', function () {
        const { wallet, net, kp, p2pkh, nested } = dogeFixture();
        const hex = psbtOf(net, [legacyInput(nested, 2, { redeemScript: p2wpkhScript(kp) })], p2pkh);
        expect(() => wallet.signPsbt(hex, kp.wif)).to.throw(/SegWit/)
            .with.property('code', 'SEGWIT_NOT_SUPPORTED');
    });

    it('refuses a DOGE input whose prevout is a native witness program', function () {
        const { wallet, net, kp, p2pkh } = dogeFixture();
        const hex = psbtOf(net, [{ hash: 'b'.repeat(64), index: 0,
            witnessUtxo: { script: p2wpkhScript(kp), value: VALUE } }], p2pkh);
        expect(() => wallet.signPsbt(hex, kp.wif)).to.throw(/SegWit/)
            .with.property('code', 'SEGWIT_NOT_SUPPORTED');
    });
});

describe('signing PSBTs on a network without segwit', function () {

    it('checks only the scoped inputs of a DOGE sign for witness spends', function () {
        const { wallet, net, kp, p2pkh } = dogeFixture();
        const other = wallet.generateKeyPair();
        const hex = psbtOf(net, [legacyInput(p2pkh, 1),
            { hash: 'c'.repeat(64), index: 0, witnessUtxo: { script: p2wpkhScript(other), value: VALUE } }], p2pkh);
        const signed = wallet.signPsbt(hex, kp.wif, { inputIndices: [0] });
        expect(signed.txHex).to.equal(null);
        expect(() => wallet.signPsbt(hex, kp.wif, { inputIndices: [1] })).to.throw(/SegWit/)
            .with.property('code', 'SEGWIT_NOT_SUPPORTED');
    });

    it('still signs and extracts a plain P2PKH DOGE spend', function () {
        const { wallet, net, kp, p2pkh } = dogeFixture();
        const signed = wallet.signPsbt(psbtOf(net, [legacyInput(p2pkh, 1)], p2pkh), kp.wif);
        const tx = bitcoin.Transaction.fromHex(signed.txHex);
        expect(tx.hasWitnesses()).to.equal(false);
    });

    it('keeps supplying the nested redeem script on a segwit network', function () {
        const wallet = new WalletUtils('litecoin-regtest');
        const net = getNetwork('litecoin-regtest');
        const kp = wallet.generateKeyPair();
        const nested = bitcoin.payments.p2sh({ redeem: { output: p2wpkhScript(kp) }, network: net }).output;
        const tx = bitcoin.Transaction.fromHex(wallet.signPsbt(psbtOf(net, [legacyInput(nested, 2)], nested), kp.wif).txHex);
        expect(tx.ins[0].witness.length).to.equal(2);
    });
});
