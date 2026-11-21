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
// The address the native-coin fee is quoted for: the funding address, then the
// change address, then the signing pubkey. submitAction and estimateFees share
// one resolver, so the same options quote for the same sender on both.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const feeMethods = require('../../../../src/XChainSDK/fees_and_services.js');
const { nativeFeeQuoteSource, sameCustomOutput, mergeNativeFeeOutputs } = require('../../../../src/carrier/native_fee_source.js');
const coins = require('../../../../src/coins');
const { FAKE_WIF, makeSdk } = require('./helpers/lifecycle_manager.js');

const FEE_DESTINATION = coins.getCoinConfig('LTC', 'mainnet').addresses.FEE_DESTINATION;
const QUOTE = {
    supported: true, valid: true, requiredFeeSats: 123456,
    requiredFeeSatsExact: '123456', feeDestination: FEE_DESTINATION,
};

const QUOTE_SOURCE_CASES = [
    [{ pubkey: 'pk', sourceAddress: 'funding', change: 'change-addr' }, 'funding'],
    [{ pubkey: 'pk', sourceAddress: 'funding' }, 'funding'],
    [{ pubkey: 'pk', change: 'change-addr' }, 'change-addr'],
    [{ pubkey: 'pk' }, 'pk'],
];

async function quotedSource(encoderOpts) {
    const sdk = makeSdk({
        explorer: { coin: 'LTC' },
        actions: { createAction: sinon.spy(() => ({ actionString: 'ISSUE|NEWTICK|x', action: 'ISSUE', version: 0 })) },
        nativeFeeRequired: feeMethods.nativeFeeRequired,
        nativeFeeOutputs: feeMethods.nativeFeeOutputs,
        quoteNativeFee: sinon.spy(async () => QUOTE),
    }, { createTx: async () => { throw new Error('stop after createTx'); } });
    await assert.rejects(
        new LifecycleManager(sdk).submitAction({ action: 'ISSUE', params: { tick: 'NEWTICK', description: 'x' } },
            encoderOpts, { wif: FAKE_WIF, waitForIndexer: false }),
        /stop after createTx/);
    return sdk.quoteNativeFee.firstCall.args[1].source;
}

describe('native-coin fee quote source', function () {
    afterEach(() => sinon.restore());

    it('resolves the funding address, then change, then the pubkey', function () {
        for (const [opts, expected] of QUOTE_SOURCE_CASES)
            assert.strictEqual(nativeFeeQuoteSource(opts), expected);
        assert.strictEqual(nativeFeeQuoteSource({}), undefined);
        assert.strictEqual(nativeFeeQuoteSource(undefined), undefined);
    });

    it('submitAction quotes the fee as the resolved source', async function () {
        for (const [opts, expected] of QUOTE_SOURCE_CASES)
            assert.strictEqual(await quotedSource(opts), expected);
    });
});

describe('native-coin fee output merge', function () {
    const fee = { address: FEE_DESTINATION, value: 500 };

    it('appends a native output the caller did not supply, without mutating either list', function () {
        const caller = [{ address: 'other', value: 600 }];
        const native = [fee];
        const merged = mergeNativeFeeOutputs(caller, native);
        assert.deepStrictEqual(merged, [{ address: 'other', value: 600 }, fee]);
        assert.strictEqual(caller.length, 1);
        assert.strictEqual(native.length, 1);
        assert.notStrictEqual(merged, caller);
    });

    it('keeps one copy when the caller already supplied the same output, number or string', function () {
        assert.deepStrictEqual(mergeNativeFeeOutputs([fee], [fee]), [fee]);
        const asString = { address: FEE_DESTINATION, value: '500' };
        assert.deepStrictEqual(mergeNativeFeeOutputs([asString], [fee]), [asString]);
        assert.strictEqual(sameCustomOutput(asString, fee), true);
        assert.strictEqual(sameCustomOutput({ address: FEE_DESTINATION, value: 501 }, fee), false);
    });

    it('treats a missing caller list as empty', function () {
        assert.deepStrictEqual(mergeNativeFeeOutputs(undefined, [fee]), [fee]);
        assert.deepStrictEqual(mergeNativeFeeOutputs(null, []), []);
    });
});
