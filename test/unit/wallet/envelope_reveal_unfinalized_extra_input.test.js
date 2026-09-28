// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const WalletUtils = require('../../../src/utils/wallet.js');
const { SDKWalletError } = require('../../../src/utils/errors.js');
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

function buildUnfinalizedExtraInput(network, keyPair, fundingTx) {
    const fundingScript = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network,
    }).output;
    return {
        hash: fundingTx.getId(),
        index: 1,
        witnessUtxo: { script: fundingScript, value: 20000 },
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
        Buffer.from('XCHAIN|SEND|unfinalized', 'utf8'),
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
    const revealPsbt = new bitcoin.Psbt({ network });
    revealPsbt.addInput({
        hash: commitTx.getId(),
        index: 0,
        witnessUtxo: { script: commitPayment.output, value: 50000 },
        tapInternalKey: xOnlyPubkey,
        tapLeafScript: [{ leafVersion: 0xc0, script: leafScript, controlBlock }],
    });
    revealPsbt.addInput(buildUnfinalizedExtraInput(network, keyPair, fundingTx));
    revealPsbt.addOutput({ script: fundingScript, value: 68000 });
    return { keyPair, revealPsbt };
}

describe('signEnvelopeRevealPsbt() with an unfinalized extra input', function () {
    it('reports extraction failure as an SDK finalization error', function () {
        const wallet = new WalletUtils('bitcoin-regtest');
        const fixture = buildFixture();
        let caught;

        try {
            wallet.signEnvelopeRevealPsbt(fixture.revealPsbt.toHex(), fixture.keyPair.toWIF());
        } catch (err) {
            caught = err;
        }

        expect(caught).to.be.instanceOf(SDKWalletError);
        expect(caught).to.have.property('code', 'FINALIZE_FAILED');
        expect(caught.message).to.match(/^Envelope reveal finalization failed: /);
    });
});
