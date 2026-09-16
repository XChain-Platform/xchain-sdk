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

// The coordinator flow's extraction step is the one place a fully
// threshold-signed transaction can still be unspendable: bitcoinjs's
// 5000 sat/vB "absurd fee" guard is calibrated for BTC's unit value and
// an ordinary DOGE fee clears it. DOGE has no segwit, so this is p2pkh
// with a nonWitnessUtxo, not the p2wpkh shape the test above uses.
function absurdFeePsbt(netName) {
    const wallet = new WalletUtils(netName);
    const net = getNetwork(netName);
    const kp = wallet.generateKeyPair();
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: net });
    const prevTx = new bitcoin.Transaction();
    prevTx.version = 1;
    prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    prevTx.addOutput(p2pkh.output, 1_000_000);
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, nonWitnessUtxo: prevTx.toBuffer() });
    // ~999,000 sat of fee over a ~191-byte tx is ~5230 sat/vB, just past
    // the default guard. The control assertion below fails loudly if that
    // margin ever stops biting, so this can never pass vacuously.
    psbt.addOutput({ script: p2pkh.output, value: 1_000 });
    return { wallet, kp, net, psbtHex: psbt.toHex() };
}

describe('WalletUtils', function() {

    describe('signMultisigPsbt() and finalizeMultisigPsbt()', function() {
        it('should throw on missing PSBT or WIF in signMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.signMultisigPsbt('', 'wif')).to.throw(/PSBT hex is required/);
            expect(() => wallet.signMultisigPsbt('abc', '')).to.throw(/WIF is required/);
        });

        it('should throw on invalid PSBT in signMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.signMultisigPsbt('deadbeef', kp.wif)).to.throw(/Failed to parse PSBT/);
        });

        it('should throw on bad WIF in signMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 1000);
            psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 1000 } });
            psbt.addOutput({ script: inputScript, value: 900 });
            expect(() => wallet.signMultisigPsbt(psbt.toHex(), 'not-a-wif')).to.throw(/Failed to import WIF/);
        });

        it('should throw on missing PSBT in finalizeMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.finalizeMultisigPsbt('')).to.throw(/PSBT hex is required/);
        });

        it('should throw on invalid PSBT in finalizeMultisigPsbt', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(() => wallet.finalizeMultisigPsbt('deadbeef')).to.throw(/Failed to parse PSBT/);
        });

    });
});

describe('WalletUtils', function() {

    describe('signMultisigPsbt() and finalizeMultisigPsbt()', function() {
        it('sign + finalize completes a 1-of-1 p2wpkh PSBT', function() {
            // Build a single-key P2WPKH PSBT, sign with signPsbt; exercise finalize path
            const wallet = new WalletUtils('bitcoin-regtest');
            const net = getNetwork('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            const inputScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            const prevTx = new bitcoin.Transaction();
            prevTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
            prevTx.addOutput(inputScript, 50_000);
            psbt.addInput({ hash: prevTx.getId(), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: inputScript, value: 50_000 } });
            psbt.addOutput({ script: inputScript, value: 49_000 });
            const psbtHex = psbt.toHex();
            // signMultisigPsbt adds partial sig but doesn't finalize
            const partial = wallet.signMultisigPsbt(psbtHex, kp.wif);
            expect(partial.psbtHex).to.be.a('string');
            // finalizeMultisigPsbt finalizes it
            const finalized = wallet.finalizeMultisigPsbt(partial.psbtHex);
            expect(finalized.txHex).to.be.a('string');
            expect(finalized.txid).to.be.a('string').of.length(64);
            expect(finalized.psbtHex).to.be.a('string');
        });
    });
});

describe('WalletUtils', function() {

    describe('signMultisigPsbt() and finalizeMultisigPsbt()', function() {
        it('finalizes a dogecoin multisig PSBT whose ordinary fee exceeds the bitcoinjs guard', function() {
            const { wallet, kp, net, psbtHex } = absurdFeePsbt('dogecoin-regtest');
            const partial = wallet.signMultisigPsbt(psbtHex, kp.wif);

            // Control: with no ceiling applied this exact PSBT is unextractable,
            // which is what left the threshold-signed funds stuck.
            const raw = bitcoin.Psbt.fromHex(partial.psbtHex, { network: net });
            raw.finalizeAllInputs();
            expect(() => raw.extractTransaction()).to.throw(/satoshi per byte/);

            // Called with NO opts: the default path is the one that was broken.
            const finalized = wallet.finalizeMultisigPsbt(partial.psbtHex);
            expect(finalized.txHex).to.be.a('string');
            expect(finalized.txid).to.be.a('string').of.length(64);
        });

        it('leaves the bitcoin absurd-fee guard intact', function() {
            const { wallet, kp, psbtHex } = absurdFeePsbt('bitcoin-regtest');
            const partial = wallet.signMultisigPsbt(psbtHex, kp.wif);
            expect(() => wallet.finalizeMultisigPsbt(partial.psbtHex)).to.throw(/satoshi per byte/);
        });

        it('honors an explicit opts.maximumFeeRate, so a caller can tighten the ceiling', function() {
            const { wallet, kp, psbtHex } = absurdFeePsbt('dogecoin-regtest');
            const partial = wallet.signMultisigPsbt(psbtHex, kp.wif);
            expect(() => wallet.finalizeMultisigPsbt(partial.psbtHex, { maximumFeeRate: 100 }))
                .to.throw(/satoshi per byte/);
        });
    });
});
