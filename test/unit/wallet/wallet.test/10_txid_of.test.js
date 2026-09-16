// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../../src/utils/wallet.js');
const { getNetwork } = require('../../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('txidOf()', function() {
        it('should throw on empty input', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.txidOf('')).to.throw(/Transaction hex string is required/);
            expect(() => wallet.txidOf(null)).to.throw(/Transaction hex string is required/);
        });

        it('should throw on invalid hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.txidOf('not-hex-at-all')).to.throw(/Failed to parse transaction/);
        });

        it('should return a 64-char txid for a valid signed transaction', function() {
            // Build and sign a minimal P2WPKH transaction via signPsbt
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.version = 2;
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 100_000);
            const prevTxId = prevTx.getId();

            psbt.addInput({
                hash: prevTxId,
                index: 0,
                sequence: 0xfffffffd,
                witnessUtxo: { script: inputScript, value: 100_000 }
            });
            psbt.addOutput({ script: outputScript, value: 90_000 });
            const psbtHex = psbt.toHex();
            const signed = wallet.signPsbt(psbtHex, kp.wif);

            const txid = wallet.txidOf(signed.txHex);
            expect(txid).to.be.a('string').of.length(64);
            expect(txid).to.equal(signed.txid);
        });
    });
});
