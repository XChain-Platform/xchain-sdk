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

const sdk = require('../../../../src/protocol/list_tick_coin.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const INDEXER_LIST_TICK_COIN =
    '../../../../../xchain-indexer/src/consensus/list_tick_coin.js';
const COINS = ['BTC', 'LTC', 'DOGE'];
const ITEMS = [
    'DOGE:PEPE',
    'doge:^12',
    'btc:foo',
    'LTC:^9',
    'Doge:Pepe',
    'ETH:FOO',
    'eth:x',
    'XCHAIN:FOO',
    ':PEPE',
    'FOO:BAR',
    'PEPE',
    '^12',
    'DOGE:A:B',
    'DOGE:',
    'BTCX:FOO',
    '',
    7,
    null,
];

describe('list tick coin SDK/indexer parity', function () {
    let indexer;

    before(function () {
        const verdict = siblingCheckout(__dirname, INDEXER_LIST_TICK_COIN);
        if (!skipOrFail(this, verdict, 'the list tick coin parity guard')) return;
        indexer = require(verdict.path);
    });

    it('uses the same separator and maximum item length', function () {
        assert.strictEqual(sdk.LIST_TICK_COIN_SEPARATOR, indexer.LIST_TICK_COIN_SEPARATOR);
        assert.strictEqual(sdk.LIST_TICK_COIN_MAX_ITEM_LENGTH, indexer.LIST_TICK_COIN_MAX_ITEM_LENGTH);
    });

    it('returns identical qualifier roots and parsed items', function () {
        for (const item of ITEMS) {
            assert.strictEqual(sdk.coinQualifierRoot(item, COINS), indexer.coinQualifierRoot(item, COINS));
            assert.deepStrictEqual(sdk.parseTickCoinItem(item, COINS), indexer.parseTickCoinItem(item, COINS));
        }
    });
});
