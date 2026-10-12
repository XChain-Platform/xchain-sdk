// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// bitcoinjs signs an input against its nonWitnessUtxo whenever one is present,
// while its fee ceiling and any witnessUtxo-first reader see the witnessUtxo.
// Every wallet entry point that signs, finalizes or shows a PSBT for approval
// must therefore refuse an input whose two UTXO fields disagree.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../../src/utils/wallet.js');
const { getNetwork } = require('../../../../src/protocol/networks.js');

const NET_NAME = 'bitcoin-regtest';
const VALUE = 1_000_000;

// A P2PKH wallet UTXO carried as its full previous transaction, plus an optional witnessUtxo.
function walletPsbt(witnessUtxoFor) {
    const wallet = new WalletUtils(NET_NAME);
    const net = getNetwork(NET_NAME);
    const kp = wallet.generateKeyPair();
    const other = wallet.generateKeyPair();
    const mine = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: net }).output;
    const theirs = bitcoin.payments.p2pkh({ pubkey: other.publicKey, network: net }).output;
    const prevTx = new bitcoin.Transaction();
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(mine, VALUE);
    const psbt = new bitcoin.Psbt({ network: net });
    const input = { hash: prevTx.getId(), index: 0, nonWitnessUtxo: prevTx.toBuffer() };
    const witnessUtxo = witnessUtxoFor && witnessUtxoFor({ mine, theirs });
    if (witnessUtxo) input.witnessUtxo = witnessUtxo;
    psbt.addInput(input);
    psbt.addOutput({ script: theirs, value: VALUE - 10_000 });
    return { wallet, kp, psbtHex: psbt.toHex() };
}

const forgedScript = ({ theirs }) => ({ script: theirs, value: VALUE });
const forgedValue = ({ mine }) => ({ script: mine, value: 1 });

describe('WalletUtils refuses disagreeing prevout fields', function () {
    it('signPsbt refuses a witnessUtxo naming a different script, and signs nothing', function () {
        const { wallet, kp, psbtHex } = walletPsbt(forgedScript);
        expect(() => wallet.signPsbt(psbtHex, kp.wif)).to.throw().with.property('code', 'INCONSISTENT_PREVOUT');
    });

    it('signPsbt refuses a witnessUtxo understating the value', function () {
        const { wallet, kp, psbtHex } = walletPsbt(forgedValue);
        expect(() => wallet.signPsbt(psbtHex, kp.wif)).to.throw().with.property('code', 'INCONSISTENT_PREVOUT');
    });

    it('signMultisigPsbt, finalizeMultisigPsbt and decomposePsbt refuse the same input', function () {
        const { wallet, kp, psbtHex } = walletPsbt(forgedScript);
        expect(() => wallet.signMultisigPsbt(psbtHex, kp.wif)).to.throw().with.property('code', 'INCONSISTENT_PREVOUT');
        expect(() => wallet.finalizeMultisigPsbt(psbtHex)).to.throw().with.property('code', 'INCONSISTENT_PREVOUT');
        expect(() => wallet.decomposePsbt(psbtHex)).to.throw().with.property('code', 'INCONSISTENT_PREVOUT');
    });

    it('still signs when the fields agree, or when only the full transaction is carried', function () {
        for (const witnessUtxoFor of [({ mine }) => ({ script: mine, value: VALUE }), null]) {
            const { wallet, kp, psbtHex } = walletPsbt(witnessUtxoFor);
            const signed = wallet.signPsbt(psbtHex, kp.wif);
            expect(signed.txid).to.be.a('string').of.length(64);
        }
    });
});
