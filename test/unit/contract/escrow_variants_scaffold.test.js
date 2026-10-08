// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');

const XChainSDK = require('../../../src/XChainSDK.js');

describe('escrow scaffold variants', function () {
    const sdk = new XChainSDK({ network: 'bitcoin-regtest', noHub: true });

    for (const name of ['escrow', 'escrowDelivery']) {
        it('ships the updated ' + name + ' source', function () {
            const source = sdk.scaffold(name);
            assert.match(source, /function requirePlainDecimal/);
            assert.match(source, /cancel:/);
        });
    }
});
