// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A P2SH-P2WPKH (nested segwit) input signs only with its redeem script, the key's
// own P2WPKH script. The signer supplies it for an input paying its own nested
// address when the PSBT leaves it out, and the transaction finalizes as segwit.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

// legacyShape builds the input as a legacy P2SH one (whole previous transaction, no
// witnessUtxo), the shape an encoder gives a P2SH input it has no key for.
function nestedSpend(kp, net, withRedeem, legacyShape) {
    const redeem = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: net });
    const nested = bitcoin.payments.p2sh({ redeem, network: net });
    const psbt = new bitcoin.Psbt({ network: net });
    const prev = new bitcoin.Transaction();
    prev.addInput(Buffer.alloc(32, 7), 0);
    prev.addOutput(nested.output, 100000);
    const input = legacyShape
        ? { hash: prev.getId(), index: 0, nonWitnessUtxo: prev.toBuffer() }
        : { hash: 'a'.repeat(64), index: 0, witnessUtxo: { script: nested.output, value: 100000 } };
    if (withRedeem) input.redeemScript = redeem.output;
    psbt.addInput(input);
    psbt.addOutput({ script: nested.output, value: 99000 });
    return { hex: psbt.toHex(), nested };
}

describe('signing P2SH-P2WPKH inputs', function () {
    for (const withRedeem of [false, true]) {
        it(`signs and finalizes a nested segwit input ${withRedeem ? 'with' : 'without'} a redeemScript in the PSBT`, function () {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const { hex, nested } = nestedSpend(kp, net, withRedeem);
            const signed = wallet.signPsbt(hex, kp.wif);
            const tx = bitcoin.Transaction.fromHex(signed.txHex);
            expect(tx.ins[0].script.equals(bitcoin.script.compile([nested.redeem.output]))).to.equal(true);
            expect(tx.ins[0].witness.length).to.equal(2);
        });
    }

    it('signs a nested segwit input built in the legacy shape, from its previous transaction', function () {
        const wallet = new WalletUtils('bitcoin-regtest');
        const kp = wallet.generateKeyPair();
        const { hex } = nestedSpend(kp, getNetwork('bitcoin-regtest'), false, true);
        const tx = bitcoin.Transaction.fromHex(wallet.signPsbt(hex, kp.wif).txHex);
        expect(tx.ins[0].witness.length).to.equal(2);
    });

    it('leaves a P2SH input it does not control unsigned', function () {
        const wallet = new WalletUtils('bitcoin-regtest');
        const net = getNetwork('bitcoin-regtest');
        const { hex } = nestedSpend(wallet.generateKeyPair(), net, false);
        expect(() => wallet.signPsbt(hex, wallet.generateKeyPair().wif)).to.throw(/No inputs were signed/);
    });
});
