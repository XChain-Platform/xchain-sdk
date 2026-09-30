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
const psbtutils = require('bitcoinjs-lib/src/psbt/psbtutils');
const ecc = require('@bitcoinerlab/secp256k1');
const WalletUtils = require('../../../src/utils/wallet.js');
const { ECPair } = require('../../../src/utils/wallet/key_derivation.js');

bitcoin.initEccLib(ecc);

function buildCommit(network, keyPair, outputScript) {
    const fundingScript = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network,
    }).output;
    const fundingTx = new bitcoin.Transaction();
    fundingTx.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([0x51]));
    fundingTx.addOutput(fundingScript, 100000);
    fundingTx.addOutput(fundingScript, 20000);

    const commitPsbt = new bitcoin.Psbt({ network });
    commitPsbt.addInput({
        hash: fundingTx.getId(),
        index: 0,
        witnessUtxo: { script: fundingScript, value: 100000 },
    });
    commitPsbt.addOutput({ script: outputScript, value: 50000 });
    commitPsbt.addOutput({ script: fundingScript, value: 49000 });
    commitPsbt.signInput(0, keyPair);
    commitPsbt.finalizeAllInputs();
    return { commitTx: commitPsbt.extractTransaction(), fundingScript, fundingTx };
}

function buildFinalizedExtraInput(network, keyPair, fundingTx) {
    const fundingScript = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network,
    }).output;
    const spendPsbt = new bitcoin.Psbt({ network });
    spendPsbt.addInput({
        hash: fundingTx.getId(),
        index: 1,
        witnessUtxo: { script: fundingScript, value: 20000 },
    });
    spendPsbt.addOutput({ script: fundingScript, value: 19000 });
    spendPsbt.signInput(0, keyPair);
    spendPsbt.finalizeAllInputs();
    return {
        hash: fundingTx.getId(),
        index: 1,
        witnessUtxo: { script: fundingScript, value: 20000 },
        finalScriptWitness: spendPsbt.data.inputs[0].finalScriptWitness,
    };
}

function buildFixture() {
    const network = bitcoin.networks.regtest;
    const keyPair = ECPair.fromPrivateKey(Buffer.alloc(32, 7), { network });
    const xOnlyPubkey = Buffer.from(keyPair.publicKey).subarray(1, 33);
    const leafScript = bitcoin.script.compile([
        bitcoin.opcodes.OP_0,
        bitcoin.opcodes.OP_IF,
        Buffer.from('XCHN', 'utf8'),
        Buffer.from([0x00]),
        Buffer.from('XCHAIN|SEND|acceptance', 'utf8'),
        bitcoin.opcodes.OP_ENDIF,
        xOnlyPubkey,
        bitcoin.opcodes.OP_CHECKSIG,
    ]);
    const scriptTree = { output: leafScript };
    const commitPayment = bitcoin.payments.p2tr({
        internalPubkey: xOnlyPubkey,
        scriptTree,
        network,
    });
    const revealPayment = bitcoin.payments.p2tr({
        internalPubkey: xOnlyPubkey,
        scriptTree,
        redeem: { output: leafScript, redeemVersion: 0xc0 },
        network,
    });
    const { commitTx, fundingScript, fundingTx } = buildCommit(
        network, keyPair, commitPayment.output);
    const controlBlock = revealPayment.witness[revealPayment.witness.length - 1];
    const extraInput = buildFinalizedExtraInput(network, keyPair, fundingTx);
    const revealPsbt = new bitcoin.Psbt({ network });
    revealPsbt.addInput({
        hash: commitTx.getId(),
        index: 0,
        witnessUtxo: { script: commitPayment.output, value: 50000 },
        tapInternalKey: xOnlyPubkey,
        tapLeafScript: [{ leafVersion: 0xc0, script: leafScript, controlBlock }],
    });
    revealPsbt.addInput(extraInput);
    revealPsbt.addOutput({ script: fundingScript, value: 68000 });
    return {
        commitPayment,
        controlBlock,
        extraInput,
        keyPair,
        leafScript,
        revealPsbt,
        xOnlyPubkey,
    };
}

describe('signEnvelopeRevealPsbt()', function () {
    it('signs a real commit/reveal pair and enforces the fee ceiling', function () {
        const wallet = new WalletUtils('bitcoin-regtest');
        const fixture = buildFixture();
        const psbtHex = fixture.revealPsbt.toHex();
        const signed = wallet.signEnvelopeRevealPsbt(
            psbtHex, fixture.keyPair.toWIF(), { maximumFeeRate: 100 });
        const revealTx = bitcoin.Transaction.fromHex(signed.txHex);
        const witness = revealTx.ins[0].witness;

        expect(revealTx.ins).to.have.lengthOf(2);
        expect(witness).to.have.lengthOf(3);
        expect(witness[1].equals(fixture.leafScript)).to.equal(true);
        expect(witness[2].equals(fixture.controlBlock)).to.equal(true);

        const serializedLeaf = Buffer.concat([
            Buffer.from([0xc0, fixture.leafScript.length]),
            fixture.leafScript,
        ]);
        const leafHash = bitcoin.crypto.taggedHash('TapLeaf', serializedLeaf);
        const sighash = revealTx.hashForWitnessV1(
            0,
            [fixture.commitPayment.output, fixture.extraInput.witnessUtxo.script],
            [50000, fixture.extraInput.witnessUtxo.value],
            bitcoin.Transaction.SIGHASH_DEFAULT,
            leafHash,
        );
        expect(ecc.verifySchnorr(sighash, fixture.xOnlyPubkey, witness[0])).to.equal(true);

        const extraWitness = psbtutils.witnessStackToScriptWitness(revealTx.ins[1].witness);
        expect(extraWitness.equals(fixture.extraInput.finalScriptWitness)).to.equal(true);
        expect(() => wallet.signEnvelopeRevealPsbt(
            psbtHex, fixture.keyPair.toWIF(), { maximumFeeRate: 1 },
        )).to.throw(/setMaximumFeeRate/);
    });
});
