// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A scoped sign that leaves a counterparty input unfinalized releases
// signatures the counterparty can complete, so it must pass the same fee
// ceiling a full extraction does.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const WalletUtils = require('../../../src/utils/wallet.js');
const { getNetwork } = require('../../../src/protocol/networks.js');
const { finalizedVsizeFloor } = require('../../../src/utils/wallet/psbt_partial_fee.js');

const NETWORK = 'bitcoin-regtest';

// Two inputs: input 0 is the signer's, input 1 a counterparty's (UTXO data optional).
function twoInputPsbt({ ownValue, foreignValue, outValue }) {
    const wallet = new WalletUtils(NETWORK);
    const net = getNetwork(NETWORK);
    const kp = wallet.generateKeyPair();
    const other = wallet.generateKeyPair();
    const ownScript = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
    const otherScript = bitcoin.payments.p2wpkh({ pubkey: other.publicKey, network: net }).output;
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: 'a'.repeat(64), index: 0, sequence: 0xfffffffd,
        witnessUtxo: { script: ownScript, value: ownValue } });
    const foreign = { hash: 'b'.repeat(64), index: 0, sequence: 0xfffffffd };
    if (foreignValue !== undefined) foreign.witnessUtxo = { script: otherScript, value: foreignValue };
    psbt.addInput(foreign);
    psbt.addOutput({ script: otherScript, value: outValue });
    return { wallet, net, kp, hex: psbt.toHex() };
}

describe('partial PSBT signing fee ceiling', function () {

    it('refuses a partial sign above an explicit maximumFeeRate', function () {
        const { wallet, kp, hex } = twoInputPsbt({ ownValue: 100000, foreignValue: 100000, outValue: 150000 });
        expect(() => wallet.signPsbt(hex, kp.wif, { inputIndices: [0], maximumFeeRate: 1 }))
            .to.throw(/ceiling/).with.property('code', 'FEE_RATE_TOO_HIGH');
    });

    it('refuses a partial sign above the default bitcoin ceiling', function () {
        const { wallet, kp, hex } = twoInputPsbt({ ownValue: 10000000, foreignValue: 100000, outValue: 1000 });
        expect(() => wallet.signPsbt(hex, kp.wif, { inputIndices: [0] }))
            .to.throw().with.property('code', 'FEE_RATE_TOO_HIGH');
    });

    it('returns the partial PSBT at an ordinary fee', function () {
        const { wallet, net, kp, hex } = twoInputPsbt({ ownValue: 100000, foreignValue: 100000, outValue: 190000 });
        const signed = wallet.signPsbt(hex, kp.wif, { inputIndices: [0], maximumFeeRate: 100 });
        expect(signed.txHex).to.equal(null);
        const out = bitcoin.Psbt.fromHex(signed.psbtHex, { network: net });
        expect(out.data.inputs[0].finalScriptWitness).to.not.equal(undefined);
        expect(out.data.inputs[1].finalScriptWitness).to.equal(undefined);
    });

    it('counts a counterparty input with no UTXO data as worth nothing', function () {
        const ok = twoInputPsbt({ ownValue: 100000, outValue: 90000 });
        expect(ok.wallet.signPsbt(ok.hex, ok.kp.wif, { inputIndices: [0] }).txHex).to.equal(null);
        const burn = twoInputPsbt({ ownValue: 10000000, outValue: 1000 });
        expect(() => burn.wallet.signPsbt(burn.hex, burn.kp.wif, { inputIndices: [0] }))
            .to.throw().with.property('code', 'FEE_RATE_TOO_HIGH');
    });

    it('refuses a counterparty input with no UTXO data under an explicit maximumFeeRate', function () {
        const { wallet, kp, hex } = twoInputPsbt({ ownValue: 100000, outValue: 190000 });
        expect(() => wallet.signPsbt(hex, kp.wif, { inputIndices: [0], maximumFeeRate: 100 }))
            .to.throw(/input 1/).with.property('code', 'FEE_UNVERIFIABLE');
    });

    it('sizes a fully finalized PSBT exactly and a partial one below its final size', function () {
        const wallet = new WalletUtils(NETWORK);
        const net = getNetwork(NETWORK);
        const kp = wallet.generateKeyPair();
        const script = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network: net }).output;
        const psbt = new bitcoin.Psbt({ network: net });
        for (const tag of ['c', 'd'])
            psbt.addInput({ hash: tag.repeat(64), index: 0, witnessUtxo: { script, value: 100000 } });
        psbt.addOutput({ script, value: 190000 });
        const partial = bitcoin.Psbt.fromHex(wallet.signPsbt(psbt.toHex(), kp.wif, { inputIndices: [0] }).psbtHex, { network: net });
        const full = wallet.signPsbt(psbt.toHex(), kp.wif);
        const finalized = bitcoin.Psbt.fromHex(full.psbtHex, { network: net });
        const realVsize = bitcoin.Transaction.fromHex(full.txHex).virtualSize();
        expect(finalizedVsizeFloor(finalized)).to.equal(realVsize);
        expect(finalizedVsizeFloor(partial)).to.be.below(realVsize);
    });
});
