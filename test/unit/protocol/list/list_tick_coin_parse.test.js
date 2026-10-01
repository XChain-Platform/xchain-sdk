// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
const assert = require('assert');
const {
    LIST_TICK_COIN_SEPARATOR,
    LIST_TICK_COIN_MAX_ITEM_LENGTH,
    coinQualifierRoot,
    parseTickCoinItem,
    isTickCoinRestWellFormed,
} = require('../../../../src/protocol/list_tick_coin.js');

describe('list_tick_coin parser', () => {
    it('exports the separator and the item length cap', () => {
        assert.strictEqual(LIST_TICK_COIN_SEPARATOR, ':');
        assert.strictEqual(LIST_TICK_COIN_MAX_ITEM_LENGTH, 200);
    });

    it('qualifies coin and future-root items', () => {
        for(const [item, root] of [['DOGE:PEPE', 'DOGE'], ['doge:^12', 'DOGE'], ['ETH:FOO', 'ETH']]){
            assert.strictEqual(coinQualifierRoot(item), root, item);
            assert.strictEqual(parseTickCoinItem(item).coin, root, item);
        }
        assert.strictEqual(parseTickCoinItem('doge:^12').canonical, 'DOGE:^12');
    });

    it('leaves every other item bare', () => {
        for(const item of [':PEPE', 'FOO:BAR', 'PEPE', '^12', 'XCHAIN:FOO']){
            assert.strictEqual(coinQualifierRoot(item), null, item);
            assert.strictEqual(parseTickCoinItem(item), null, item);
        }
    });

    it('splits at the first colon', () => {
        assert.strictEqual(parseTickCoinItem('DOGE:A:B').rest, 'A:B');
    });

    it('honours a caller-supplied coin list', () => {
        assert.strictEqual(coinQualifierRoot('btc:X', ['BTC']), 'BTC');
        assert.strictEqual(coinQualifierRoot('DOGE:X', ['BTC']), null);
        assert.strictEqual(coinQualifierRoot('DOGE:X', null), null);
        assert.strictEqual(coinQualifierRoot('ETH:X', null), 'ETH');
    });

    it('accepts well-formed rests', () => {
        assert.strictEqual(isTickCoinRestWellFormed('PEPE', 'DOGE:PEPE'), true);
        assert.strictEqual(isTickCoinRestWellFormed('^12', 'DOGE:^12'), true);
        assert.strictEqual(isTickCoinRestWellFormed('A:B', 'DOGE:A:B'), true);
    });

    it('rejects malformed rests', () => {
        assert.strictEqual(isTickCoinRestWellFormed('^012', 'DOGE:^012'), false);
        assert.strictEqual(isTickCoinRestWellFormed('^0', 'DOGE:^0'), false);
        assert.strictEqual(isTickCoinRestWellFormed('', 'DOGE:'), false);
        const long = 'A'.repeat(196);
        assert.strictEqual(isTickCoinRestWellFormed(long, 'DOGE:' + long), false);
        assert.strictEqual(isTickCoinRestWellFormed('A'.repeat(195), 'DOGE:' + 'A'.repeat(195)), true);
    });
});
