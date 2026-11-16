// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const XChainSDK = require('../../../../src/XChainSDK.js');

bitcoin.initEccLib(ecc);
const NET = bitcoin.networks.regtest;
const ECPair = ECPairFactory(ecc);
const ACTION = { action: 'SEND', params: {} };
const ACTION_RESULT = { action: 'SEND', actionString: 'XCHAIN', version: 1 };

function destination(fill) {
    const key = ECPair.fromPrivateKey(Buffer.alloc(32, fill), { network: NET });
    return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.publicKey), network: NET });
}

function envelopePair(revealDestination, revealValue) {
    const mine = destination(1);
    const leg = bitcoin.script.compile([bitcoin.opcodes.OP_1, Buffer.alloc(32, 7)]);
    const carrier = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('XCHAIN')]);
    const commit = new bitcoin.Psbt({ network: NET });
    commit.addInput({ hash: 'aa'.repeat(32), index: 0,
        witnessUtxo: { script: mine.output, value: 100000 } });
    commit.addOutput({ script: carrier, value: 0 });
    commit.addOutput({ script: leg, value: 50000 });
    commit.addOutput({ script: mine.output, value: 49000 });
    const reveal = new bitcoin.Psbt({ network: NET });
    reveal.addInput({ hash: 'cc'.repeat(32), index: 0,
        witnessUtxo: { script: leg, value: 50000 } });
    reveal.addOutput({ script: revealDestination.output, value: revealValue });
    return { psbt: commit.toHex(), revealPsbt: reveal.toHex(), encoding: 'TAPROOT', fee: 1000 };
}

async function estimate(pair, opts) {
    const sdk = {
        actions: { createAction: () => ACTION_RESULT },
        wallet: { getBitcoinNetwork: () => NET },
        nativeFeeRequired: () => false,
        requireEncoder: () => ({ estimateFee: async () => Object.assign({}, pair) }),
    };
    return XChainSDK.prototype.estimateFees.call(sdk, ACTION, opts);
}

async function estimateError(pair, opts) {
    try { await estimate(pair, opts); } catch (error) { return error; }
    throw new Error('expected estimateFees to refuse the envelope pair');
}

describe('estimateFees envelope reveal reconciliation', function () {
    it('applies maxFeeSats to the reveal as well as the commit', async function () {
        const change = destination(2);
        const error = await estimateError(envelopePair(change, 40000),
            { pubkey: 'caller', change: change.address, maxFeeSats: 5000 });
        assert.strictEqual(error.code, 'FEE_OVER_CAP');
        assert.match(error.message, /envelope reveal/);
    });

    it('accepts both legs when each fee is at the cap', async function () {
        const change = destination(3);
        const result = await estimate(envelopePair(change, 40000),
            { pubkey: 'caller', change: change.address, maxFeeSats: 10000 });
        assert.strictEqual(result.psbt, null);
        assert.strictEqual(result.signable, false);
        assert.strictEqual(result.revealPsbt, undefined);
    });

    it('refuses an unauthorized reveal output', async function () {
        const change = destination(4);
        const error = await estimateError(envelopePair(destination(5), 49000),
            { pubkey: 'caller', change: change.address, maxFeeSats: 10000 });
        assert.strictEqual(error.code, 'UNRECONCILED_OUTPUT');
        assert.match(error.message, /envelope reveal/);
    });
});
