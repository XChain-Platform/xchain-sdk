/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Native-coin fee destination pin tests
 *
 * The native fee output is authorized later as caller intent, so the
 * SDK must take its address from the pinned coin bundle and refuse a
 * remote quote that names any other address or a malformed amount.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
const { XChainSDK } = require('../../../index.js');
const coins = require('../../../src/coins');
const { parseCoinCode } = require('../../../src/utils/endpoints.js');

bitcoin.initEccLib(ecc);

const ISSUE = { action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } };
const ATTACKER = 'LhVQUXo7FkwSxpZdh7mPTtLUBKcQyHM5tk';

// Build an encoder-shaped answer that clears the reconcile gate on an honest run
function estimatePsbtHex() {
    const net = bitcoin.networks.regtest;
    const kp = ECPairFactory(ecc).makeRandom({ network: net });
    const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: net }).output;
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script, value: 100000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
    psbt.addOutput({ script, value: 99000 });
    return psbt.toHex();
}

// Read the consensus-pinned fee address for a route coin
function pinnedFeeDest(coin) {
    const plane = parseCoinCode(coin);
    return coins.getCoinConfig(plane.coin, plane.network).addresses.FEE_DESTINATION;
}

// Build an SDK whose stub explorer answers every quote with `quote` on route `coin`
function onChain(coin, quote) {
    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
    sdk.explorer = {
        coin,
        _seen: null,
        getFeeQuote: async function (args) { this._seen = args; return Object.assign({}, quote); },
    };
    sdk.encoder = {
        _seen: null,
        estimateFee: async function (params) { this._seen = params; return { fee: 1000, encoding: 'OP_RETURN', psbt: estimatePsbtHex() }; },
    };
    return sdk;
}

async function refusal(p) {
    try { await p; } catch (e) { return e; }
    return null;
}

describe('Native-coin fee destination pin', function () {

    it('estimateFees refuses a mainnet quote naming a non-pinned destination before the encoder is asked', async function () {
        const sdk = onChain('LTC', { supported: true, valid: true, requiredFeeSats: 2000, feeDestination: ATTACKER });
        const err = await refusal(sdk.estimateFees(ISSUE, { pubkey: 'pk', change: 'src1' }));
        expect(err, 'a foreign destination must refuse').to.exist;
        expect(err.code).to.equal('NATIVE_FEE_DESTINATION_MISMATCH');
        expect(err.details.pinned).to.equal(pinnedFeeDest('LTC'));
        expect(sdk.encoder._seen, 'nothing reaches the encoder').to.equal(null);
    });

    it('nativeFeeOutputs refuses a testnet quote naming a non-pinned destination', async function () {
        const sdk = onChain('TDOGE', { supported: true, valid: true, requiredFeeSats: 2000, feeDestination: ATTACKER });
        const err = await refusal(sdk.nativeFeeOutputs(ISSUE, {}));
        expect(err).to.exist;
        expect(err.code).to.equal('NATIVE_FEE_DESTINATION_MISMATCH');
    });

    it('estimateFees pays the pinned address when the quote names it', async function () {
        const sdk = onChain('DOGE', { supported: true, valid: true, requiredFeeSats: '2000', feeDestination: pinnedFeeDest('DOGE') });
        await sdk.estimateFees(ISSUE, { pubkey: 'pk', change: 'src1' });
        expect(sdk.encoder._seen.customOutputs).to.deep.equal([{ address: pinnedFeeDest('DOGE'), value: 2000 }]);
    });

    it('estimateFees refuses a malformed fee amount before the encoder is asked', async function () {
        for (const requiredFeeSats of [1.5, -1, 2 ** 53 + 2, 'abc', '1e3']) {
            const sdk = onChain('LTC', { supported: true, valid: true, requiredFeeSats, feeDestination: pinnedFeeDest('LTC') });
            const err = await refusal(sdk.estimateFees(ISSUE, { pubkey: 'pk', change: 'src1' }));
            expect(err, String(requiredFeeSats)).to.exist;
            expect(err.code, String(requiredFeeSats)).to.equal('NATIVE_FEE_INVALID');
            expect(sdk.encoder._seen, String(requiredFeeSats)).to.equal(null);
        }
    });

    it('estimateFees with an explicit opt-in refuses when the connected chain is unknown', async function () {
        const sdk = onChain(undefined, { supported: true, valid: true, requiredFeeSats: 2000, feeDestination: ATTACKER });
        const err = await refusal(sdk.estimateFees(ISSUE, { payFeeInNativeCoin: true, pubkey: 'pk', change: 'src1' }));
        expect(err).to.exist;
        expect(err.code).to.equal('NATIVE_FEE_DESTINATION_UNPINNED');
        expect(sdk.encoder._seen).to.equal(null);
    });

    it('estimateFees on regtest takes the quoted destination, since the node may carry an env override', async function () {
        const sdk = onChain('RLTC', { supported: true, valid: true, requiredFeeSats: 2000, feeDestination: 'regtestOverride' });
        await sdk.estimateFees(ISSUE, { pubkey: 'pk', change: 'src1' });
        expect(sdk.encoder._seen.customOutputs).to.deep.equal([{ address: 'regtestOverride', value: 2000 }]);
    });
});
