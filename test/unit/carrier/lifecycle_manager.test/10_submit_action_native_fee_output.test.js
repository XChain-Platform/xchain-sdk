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
const sinon = require('sinon');
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const feeMethods = require('../../../../src/XChainSDK/fees_and_services.js');
const coins = require('../../../../src/coins');
const { FAKE_WIF, makeSdk } = require('./helpers/lifecycle_manager.js');

const ACTION = { action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } };
const ACTION_STRING = 'ISSUE|NEWTICK|x';
const FEE_DESTINATION = coins.getCoinConfig('LTC', 'mainnet').addresses.FEE_DESTINATION;
const FEE_OUTPUT = { address: FEE_DESTINATION, value: 123456 };
const GOOD_QUOTE = {
    supported: true, valid: true, requiredFeeSats: 123456,
    requiredFeeSatsExact: '123456', feeDestination: FEE_DESTINATION,
};

function sdkForQuote(quote, createTx) {
    const sdk = makeSdk({
        explorer: { coin: 'LTC' },
        actions: {
            createAction: sinon.spy(() => ({
                actionString: ACTION_STRING, action: 'ISSUE', version: 0,
            })),
        },
        nativeFeeRequired: feeMethods.nativeFeeRequired,
        nativeFeeOutputs: feeMethods.nativeFeeOutputs,
        quoteNativeFee: sinon.spy(async () => quote),
    }, { createTx });
    return sdk;
}

async function stoppedSubmit(sdk, encoderOpts = {}, submitOpts = {}) {
    await assert.rejects(
        new LifecycleManager(sdk).submitAction(ACTION,
            { pubkey: 'sender', change: 'source-address', ...encoderOpts },
            { wif: FAKE_WIF, waitForIndexer: false, ...submitOpts }),
        /stop after createTx/);
}

describe('LifecycleManager submitAction(): native-coin fee output', function () {
    afterEach(() => sinon.restore());

    it('adds the required output by default on a registry-native chain', async function () {
        let request;
        const sdk = sdkForQuote(GOOD_QUOTE, async (params) => {
            request = params;
            throw new Error('stop after createTx');
        });

        await stoppedSubmit(sdk);

        assert.deepStrictEqual(request.customOutputs, [FEE_OUTPUT]);
        assert.strictEqual(sdk.quoteNativeFee.firstCall.args[0], ACTION_STRING);
        assert.strictEqual(sdk.quoteNativeFee.firstCall.args[1].source, 'source-address');
    });

    it('does not duplicate an output supplied by the documented workaround', async function () {
        let request;
        const sdk = sdkForQuote(GOOD_QUOTE, async (params) => {
            request = params;
            throw new Error('stop after createTx');
        });

        await stoppedSubmit(sdk, { customOutputs: [FEE_OUTPUT] });

        assert.deepStrictEqual(request.customOutputs, [FEE_OUTPUT]);
    });

    it('honours a workflow-level native-fee opt-out', async function () {
        let request;
        const sdk = sdkForQuote(GOOD_QUOTE, async (params) => {
            request = params;
            throw new Error('stop after createTx');
        });

        await stoppedSubmit(sdk, {}, { payFeeInNativeCoin: false });

        assert.strictEqual(request.customOutputs, undefined);
        assert.strictEqual(sdk.quoteNativeFee.callCount, 0);
    });

    it('refuses a hostile fee destination before the encoder or broadcaster runs', async function () {
        const createTx = sinon.spy(async () => { throw new Error('encoder must not run'); });
        const hostile = { ...GOOD_QUOTE, feeDestination: 'LhVQUXo7FkwSxpZdh7mPTtLUBKcQyHM5tk' };
        const sdk = sdkForQuote(hostile, createTx);
        const broadcast = sinon.spy(sdk.requireEncoder(), 'broadcastTx');

        await assert.rejects(
            new LifecycleManager(sdk).submitAction(ACTION,
                { pubkey: 'sender', change: 'source-address' },
                { wif: FAKE_WIF, waitForIndexer: false }),
            error => error && error.code === 'NATIVE_FEE_DESTINATION_MISMATCH');

        assert.strictEqual(createTx.callCount, 0);
        assert.strictEqual(broadcast.callCount, 0);
    });
});
