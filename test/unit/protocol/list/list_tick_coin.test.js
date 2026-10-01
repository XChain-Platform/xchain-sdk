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
const fs = require('fs');
const path = require('path');
const sdkParser = require('../../../../src/protocol/list_tick_coin.js');

const INDEXER_LIST_TICK_COIN =
    '../../../../../xchain-indexer/src/consensus/list_tick_coin.js';
const COINS = ['BTC', 'LTC', 'DOGE'];

describe('coin-qualified LIST ticker items', function(){
    it('exports the canonical separator and storage-bound length', function(){
        assert.strictEqual(sdkParser.LIST_TICK_COIN_SEPARATOR, ':');
        assert.strictEqual(sdkParser.LIST_TICK_COIN_MAX_ITEM_LENGTH, 200);
    });

    it('recognizes configured coins and reserved future roots case-insensitively', function(){
        assert.strictEqual(sdkParser.coinQualifierRoot('DOGE:PEPE'), 'DOGE');
        assert.strictEqual(sdkParser.coinQualifierRoot('doge:^12'), 'DOGE');
        assert.strictEqual(sdkParser.coinQualifierRoot('ETH:FOO'), 'ETH');
    });

    it('leaves non-qualifying items bare', function(){
        for(const item of [':PEPE', 'FOO:BAR', 'PEPE', '^12', 'XCHAIN:FOO']){
            assert.strictEqual(sdkParser.coinQualifierRoot(item), null, item);
            assert.strictEqual(sdkParser.parseTickCoinItem(item), null, item);
        }
    });

    it('canonicalizes the root and preserves the rest exactly', function(){
        assert.deepStrictEqual(sdkParser.parseTickCoinItem('doge:^12'), {
            coin: 'DOGE',
            rest: '^12',
            canonical: 'DOGE:^12',
        });
        assert.deepStrictEqual(sdkParser.parseTickCoinItem('DOGE:A:B'), {
            coin: 'DOGE',
            rest: 'A:B',
            canonical: 'DOGE:A:B',
        });
    });

    it('accepts canonical ids and configured ticker names', function(){
        for(const item of ['doge:^12', 'DOGE:PEPE', 'DOGE:A:B', 'DOGE:' + 'A'.repeat(195)]){
            const parsed = sdkParser.parseTickCoinItem(item);
            assert.strictEqual(
                sdkParser.isTickCoinRestWellFormed(parsed.rest, parsed.canonical),
                true,
                item
            );
        }
    });

    it('rejects noncanonical ids, an empty rest and an item over 200 characters', function(){
        for(const item of ['DOGE:^012', 'DOGE:^0', 'DOGE:', 'DOGE:' + 'A'.repeat(196)]){
            const parsed = sdkParser.parseTickCoinItem(item);
            assert.strictEqual(
                sdkParser.isTickCoinRestWellFormed(parsed.rest, parsed.canonical),
                false,
                item
            );
        }
    });

    it('matches the sibling indexer parser over a fixed item set', function(){
        const siblingPath = path.resolve(__dirname, INDEXER_LIST_TICK_COIN);
        if(!fs.existsSync(siblingPath)){
            if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling parser is absent: ' + siblingPath);
            this.skip();
            return;
        }
        const indexerParser = require(siblingPath);
        const items = [
            'DOGE:PEPE', 'doge:^12', 'btc:foo', 'LTC:^9', 'Doge:Pepe',
            'ETH:FOO', 'eth:x', 'XCHAIN:FOO', ':PEPE', 'FOO:BAR', 'PEPE',
            '^12', 'DOGE:A:B', 'DOGE:', 'BTCX:FOO', '', 7, null,
        ];

        assert.strictEqual(sdkParser.LIST_TICK_COIN_SEPARATOR, indexerParser.LIST_TICK_COIN_SEPARATOR);
        assert.strictEqual(sdkParser.LIST_TICK_COIN_MAX_ITEM_LENGTH, indexerParser.LIST_TICK_COIN_MAX_ITEM_LENGTH);
        for(const item of items){
            assert.deepStrictEqual(
                sdkParser.parseTickCoinItem(item, COINS),
                indexerParser.parseTickCoinItem(item, COINS),
                String(item)
            );
        }
    });

    it('reads the mirrored gate from the explorer tip and fails closed', async function(){
        const sdk = (network, explorer) => ({ config: { network }, explorer });
        const regtestExplorer = {
            coin: 'RBTC',
            async getStatus(){ return { last_block: { RBTC: 0 } }; },
        };
        const mainnetExplorer = {
            coin: 'BTC',
            async getStatus(){ return { last_block: { BTC: 999999999 } }; },
        };

        assert.strictEqual(await sdkParser.isListTickCoinActive(sdk('bitcoin-regtest', regtestExplorer)), true);
        assert.strictEqual(await sdkParser.isListTickCoinActive(sdk('bitcoin-mainnet', mainnetExplorer)), false);
        assert.strictEqual(await sdkParser.isListTickCoinActive(sdk('bitcoin-regtest', null)), false);
    });
});
