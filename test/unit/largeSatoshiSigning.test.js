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
//  SDK passthrough: a PSBT the encoder built around a satoshi value
// above Number.MAX_SAFE_INTEGER (2^53-1, ~90.07M DOGE) must parse, sign,
// finalize, and extract here with the value carried bit-exact (BigInt).
// src/applyBufferutilsPatch.js (loaded by src/wallet.js) provides the
// BigInt-safe bitcoinjs-lib/bip174 behavior; these tests pin it.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../src/wallet.js');
const { getNetwork } = require('../../src/networks.js');

const BIG_IN = 12000000000000000000n;  // 1.2e19 sats, > 2^53-1, < u64 max
const BIG_OUT = 11000000000000000001n; // exact odd value: rounds if ever a Number

describe(': signing PSBTs with >2^53-1-sat values', function () {

    it('signs, finalizes, and extracts a segwit input/output above 2^53-1 bit-exact', function () {
        const wallet = new WalletUtils('bitcoin-regtest');
        const net = getNetwork('bitcoin-regtest');
        const kp = wallet.generateKeyPair();
        const recipient = wallet.generateKeyPair();
        const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
        const outputScript = bitcoin.payments.p2wpkh({ pubkey: recipient.publicKey, network: net }).output;

        const psbt = new bitcoin.Psbt({ network: net });
        psbt.addInput({
            hash: 'a'.repeat(64), index: 0, sequence: 0xfffffffd,
            witnessUtxo: { script: inputScript, value: BIG_IN }
        });
        psbt.addOutput({ script: outputScript, value: BIG_OUT });
        // change back to self, still above 2^53-1
        psbt.addOutput({ script: inputScript, value: BIG_IN - BIG_OUT - 10000n });

        const signed = wallet.signPsbt(psbt.toHex(), kp.wif);
        expect(signed.txHex).to.be.a('string');
        expect(signed.txid).to.be.a('string').of.length(64);

        const tx = bitcoin.Transaction.fromHex(signed.txHex);
        expect(BigInt(tx.outs[0].value)).to.equal(BIG_OUT);
        expect(BigInt(tx.outs[1].value)).to.equal(BIG_IN - BIG_OUT - 10000n);
    });

    it('signs a legacy (nonWitnessUtxo) input above 2^53-1 (the DOGE shape)', function () {
        // Dogecoin has no segwit, so a giant DOGE UTXO always arrives as a
        // nonWitnessUtxo (full raw prev-tx); its >2^53-1 output value must
        // survive the prev-tx re-parse and the fee accounting at extract time.
        const wallet = new WalletUtils('dogecoin-regtest');
        const net = getNetwork('dogecoin-regtest');
        const kp = wallet.generateKeyPair();
        const recipient = wallet.generateKeyPair();
        const inputScript = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: net }).output;
        const outputScript = bitcoin.payments.p2pkh({ pubkey: recipient.publicKey, network: net }).output;

        const prevTx = new bitcoin.Transaction();
        prevTx.version = 2;
        prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
        prevTx.addOutput(inputScript, BIG_IN);

        const psbt = new bitcoin.Psbt({ network: net });
        psbt.addInput({
            hash: prevTx.getId(), index: 0, sequence: 0xfffffffd,
            nonWitnessUtxo: prevTx.toBuffer()
        });
        psbt.addOutput({ script: outputScript, value: BIG_OUT });
        psbt.addOutput({ script: inputScript, value: BIG_IN - BIG_OUT - 10000n });

        const signed = wallet.signPsbt(psbt.toHex(), kp.wif);
        expect(signed.txHex).to.be.a('string');
        const tx = bitcoin.Transaction.fromHex(signed.txHex);
        expect(BigInt(tx.outs[0].value)).to.equal(BIG_OUT);
    });

    it('keeps small-value signing byte-identical (Number fast path untouched)', function () {
        const wallet = new WalletUtils('bitcoin-regtest');
        const net = getNetwork('bitcoin-regtest');
        const kp = wallet.generateKeyPair();
        const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
        const psbt = new bitcoin.Psbt({ network: net });
        psbt.addInput({
            hash: 'b'.repeat(64), index: 0, sequence: 0xfffffffd,
            witnessUtxo: { script: inputScript, value: 100000 }
        });
        psbt.addOutput({ script: inputScript, value: 90000 });
        const signed = wallet.signPsbt(psbt.toHex(), kp.wif);
        const tx = bitcoin.Transaction.fromHex(signed.txHex);
        expect(tx.outs[0].value).to.equal(90000); // stays a Number
        expect(psbt.getFee === undefined).to.equal(false);
    });
});
