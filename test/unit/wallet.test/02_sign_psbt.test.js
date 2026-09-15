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
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('signPsbt()', function() {
        it('should throw on missing PSBT', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signPsbt('', 'wif')).to.throw(/PSBT hex string is required/);
        });

        it('should throw on missing WIF', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signPsbt('deadbeef', '')).to.throw(/WIF private key is required/);
        });

        it('should throw INVALID_PSBT on non-PSBT hex', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.signPsbt('deadbeef', kp.wif)).to.throw(/Failed to parse PSBT/);
        });

        // Regression for #5318: a dApp-supplied PSBT can mix in extra UTXOs the
        // active key controls. With opts.inputIndices the wallet must sign ONLY the
        // approved inputs and leave the rest untouched, returning the partial PSBT
        // (not a finalized/broadcastable tx) so the unapproved UTXOs are never spent.
        it('signs only the scoped inputs when opts.inputIndices is given', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const recipient = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

            // Two inputs, BOTH spendable by kp (simulating the crafted PSBT that mixes
            // the user's other UTXO in beyond the one they approved).
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.version = 2;
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 100_000);
            prevTx.addOutput(inputScript, 100_000);
            const prevTxId = prevTx.getId();
            psbt.addInput({ hash: prevTxId, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 100_000 } });
            psbt.addInput({ hash: prevTxId, index: 1, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 100_000 } });
            psbt.addOutput({ script: outputScript, value: 150_000 });

            const signed = wallet.signPsbt(psbt.toHex(), kp.wif, { inputIndices: [0] });

            // Incomplete tx (input 1 unsigned), so no broadcastable extraction.
            expect(signed.txHex).to.equal(null);
            expect(signed.txid).to.equal(null);
            const out = bitcoin.Psbt.fromHex(signed.psbtHex, { network: net });
            expect(out.data.inputs[0].finalScriptWitness, 'approved input 0 finalized').to.not.equal(undefined);
            expect(out.data.inputs[1].finalScriptWitness, 'unapproved input 1 untouched').to.equal(undefined);
            expect(out.data.inputs[1].partialSig, 'unapproved input 1 unsigned').to.equal(undefined);
        });
    });
});

describe('WalletUtils', function() {

    describe('signPsbt()', function() {
        it('signs and finalizes all inputs when opts.inputIndices is omitted (back-compat)', function() {
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
            psbt.addInput({ hash: prevTxId, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 100_000 } });
            psbt.addOutput({ script: outputScript, value: 90_000 });

            const signed = wallet.signPsbt(psbt.toHex(), kp.wif);
            expect(signed.txHex).to.be.a('string');
            expect(signed.txid).to.be.a('string').of.length(64);
        });
    });
});
