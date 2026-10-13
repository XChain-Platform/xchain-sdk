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
const feeMethods = require('../../../src/XChainSDK/fees_and_services.js');

const DEST = 'Lfees7tszAx5Gqam2fuqf6biaX3LXafM4H';

function sdkWith(quote) {
    return {
        explorer: { coin: 'RLTC' },
        quoteNativeFee: sinon.spy(async () => quote),
        nativeFeeRequired: feeMethods.nativeFeeRequired,
    };
}

async function outputs(quote) {
    return feeMethods.nativeFeeOutputs.call(sdkWith(quote), 'SEND|x', { payFeeInNativeCoin: true });
}

describe('native fee sizing from requiredFeeSatsExact', function () {
    it('sizes the output from the exact amount, ignoring the lossy number', async function () {
        const out = await outputs({ supported: true, valid: true, requiredFeeSats: 1, requiredFeeSatsExact: '777', feeDestination: DEST });
        assert.deepStrictEqual(out, [{ address: DEST, value: 777 }]);
    });

    it('refuses a priced quote that omits requiredFeeSatsExact', async function () {
        for (const valid of [true, null]) {
            await assert.rejects(outputs({ supported: true, valid, requiredFeeSats: 500, feeDestination: DEST }),
                err => err.code === 'NATIVE_FEE_INVALID');
        }
    });

    it('refuses a malformed exact amount', async function () {
        for (const bad of ['abc', '1.5', -1, '9007199254740993']) {
            await assert.rejects(outputs({ supported: true, valid: true, requiredFeeSatsExact: bad, feeDestination: DEST }),
                err => err.code === 'NATIVE_FEE_INVALID', String(bad));
        }
    });

    it('adds no output for an exact zero', async function () {
        assert.deepStrictEqual(await outputs({ supported: true, valid: true, requiredFeeSatsExact: '0', feeDestination: DEST }), []);
    });
});
