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

    describe('signRevealPsbt()', function() {
        it('should throw on missing PSBT', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signRevealPsbt('', 'wif')).to.throw(/PSBT hex string is required/);
            expect(() => wallet.signRevealPsbt(null, 'wif')).to.throw(/PSBT hex string is required/);
        });

        it('should throw on missing WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signRevealPsbt('deadbeef', '')).to.throw(/WIF private key is required/);
        });

        it('should throw INVALID_WIF on bad WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            // Build a minimal valid PSBT so it parses, but the WIF is bad
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 1000);
            psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 1000 } });
            psbt.addOutput({ script: inputScript, value: 900 });
            expect(() => wallet.signRevealPsbt(psbt.toHex(), 'not-a-wif')).to.throw(/Failed to import WIF/);
        });

        it('should throw INVALID_PSBT on non-PSBT hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.signRevealPsbt('deadbeef01020304', kp.wif)).to.throw(/Failed to parse PSBT/);
        });
    });
});

describe('WalletUtils', function() {

    describe('signRevealPsbt()', function() {
        it('should sign and finalize a P2SH reveal PSBT', function() {
            // Build a PSBT that simulates the XChain P2SH "reveal" pattern:
            // the redeem script is a simple non-standard 1-push script (OP_TRUE),
            // and bitcoinjs-lib's custom finalizer assembles the scriptSig.
            // To be signable, we use a P2PKH-style script that ECPair can sign.
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();

            // Build a minimal P2SH input whose redeem script is a simple
            // pay-to-pubkey so signAllInputs can produce a partialSig.
            const redeemScript = bitcoin.script.compile([
                kp.publicKey,
                bitcoin.opcodes.OP_CHECKSIG,
            ]);
            const p2sh = bitcoin.payments.p2sh({
                redeem: { output: redeemScript, network: net },
                network: net,
            });
            const inputScript = p2sh.output;

            // Create the prev-tx
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 50_000);

            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({
                hash:           prevTx.getId(),
                index:          0,
                sequence:       0xfffffffd,
                nonWitnessUtxo: prevTx.toBuffer(),
                redeemScript:   redeemScript,
            });
            psbt.addOutput({ script: inputScript, value: 49_000 });

            const result = wallet.signRevealPsbt(psbt.toHex(), kp.wif);
            expect(result.txHex).to.be.a('string');
            expect(result.txid).to.be.a('string').of.length(64);
            expect(result.psbtHex).to.be.a('string');
        });
    });
});
