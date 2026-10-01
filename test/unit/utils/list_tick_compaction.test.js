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
const XChainSDK = require('../../../src/XChainSDK.js');
const TickResolver = require('../../../src/utils/tick_resolver.js');
const Utility = require('../../../src/utils/utility.js');
const { isListTickCoinActive } = require('../../../src/protocol/list_tick_coin.js');

function tokenClient(tokens, calls) {
    return {
        async getToken(rest, options) {
            calls.push({ rest, options });
            if (tokens[rest] instanceof Error) throw tokens[rest];
            if (!Object.prototype.hasOwnProperty.call(tokens, rest)) return null;
            return { info: { tick_id: tokens[rest] } };
        }
    };
}

function harness(options = {}) {
    const network = options.network || 'bitcoin-regtest';
    const coin = network.endsWith('-regtest') ? 'RBTC' : 'BTC';
    const btcCalls = [];
    const dogeCalls = [];
    let parentCalls = 0;
    let statusCalls = 0;
    const explorer = Object.assign(tokenClient(options.btcTokens || {}, btcCalls), {
        coin,
        baseUrl: 'http://explorer.test',
        port: 8080,
        timeout: 100,
        retry: false,
        hooks: {},
        async getStatus() {
            statusCalls += 1;
            return { last_block: { [coin]: 0 } };
        },
        async getAction() {
            parentCalls += 1;
            return { type: options.parentType };
        }
    });
    const sdk = {
        options: { network, compactTickers: options.compactTickers },
        config: { network },
        util: new Utility(),
        explorer
    };
    const resolver = new TickResolver(sdk);
    resolver.listCoinExplorers = {
        DOGE: tokenClient(options.dogeTokens || {}, dogeCalls)
    };
    return {
        resolver,
        btcCalls,
        dogeCalls,
        parentCalls: () => parentCalls,
        statusCalls: () => statusCalls
    };
}

describe('LIST ticker item compaction', function () {
    it('uses the SDK explorer for BTC and the per-coin client for DOGE', async function () {
        const h = harness({ btcTokens: { FOO: 5 }, dogeTokens: { PEPE: 12 } });
        const out = await h.resolver.resolveActionParams('LIST', {
            TYPE: '1', ITEM: ['DOGE:PEPE', 'BTC:FOO']
        });

        assert.deepStrictEqual(out.ITEM, ['DOGE:^12', 'BTC:^5']);
        assert.deepStrictEqual(h.dogeCalls, [{ rest: 'PEPE', options: { noRetry: true } }]);
        assert.deepStrictEqual(h.btcCalls, [{ rest: 'FOO', options: { noRetry: true } }]);
    });

    it('does not compact on an unarmed mainnet', async function () {
        const h = harness({
            network: 'bitcoin-mainnet',
            btcTokens: { FOO: 5 },
            dogeTokens: { PEPE: 12 }
        });
        const input = { TYPE: '1', ITEM: ['DOGE:PEPE', 'BTC:FOO'] };

        assert.deepStrictEqual(await h.resolver.resolveActionParams('LIST', input), input);
        assert.strictEqual(h.statusCalls(), 0);
        assert.deepStrictEqual(h.btcCalls, []);
        assert.deepStrictEqual(h.dogeCalls, []);
    });

    it('keeps names when a lookup fails or reaches the cap', async function () {
        const h = harness({ dogeTokens: { FAIL: new Error('offline') } });
        const hangingCalls = [];
        h.resolver.lookupCapMs = 5;
        h.resolver.listCoinExplorers.LTC = {
            getToken(rest, options) {
                hangingCalls.push({ rest, options });
                return new Promise(() => {});
            }
        };

        const out = await h.resolver.resolveActionParams('LIST', {
            TYPE: 1, ITEM: ['DOGE:FAIL', 'LTC:SLOW']
        });

        assert.deepStrictEqual(out.ITEM, ['DOGE:FAIL', 'LTC:SLOW']);
        assert.deepStrictEqual(hangingCalls, [{ rest: 'SLOW', options: { noRetry: true } }]);
    });

    it('leaves bare, id-form and future-root items untouched', async function () {
        const h = harness({ dogeTokens: { PEPE: 12 } });
        const items = ['PEPE', 'DOGE:^12', 'ETH:FOO'];
        const out = await h.resolver.resolveActionParams('LIST', { TYPE: 1, ITEM: items });

        assert.deepStrictEqual(out.ITEM, items);
        assert.deepStrictEqual(h.dogeCalls, []);
    });

    it('compacts a format 1 edit only when its parent is a ticker list', async function () {
        const ticker = harness({ parentType: 1, dogeTokens: { PEPE: 12 } });
        const address = harness({ parentType: 2, dogeTokens: { PEPE: 12 } });
        const params = { VERSION: 1, EDIT: 1, LIST_ACTION_INDEX: 41, ITEM: 'DOGE:PEPE' };

        assert.strictEqual((await ticker.resolver.resolveActionParams('LIST', params)).ITEM, 'DOGE:^12');
        assert.strictEqual((await address.resolver.resolveActionParams('LIST', params)).ITEM, 'DOGE:PEPE');
        assert.strictEqual(ticker.parentCalls(), 1);
        assert.strictEqual(address.parentCalls(), 1);
        assert.deepStrictEqual(address.dogeCalls, []);
    });

    it('returns the original params when compactTickers is false', async function () {
        const h = harness({ compactTickers: false, dogeTokens: { PEPE: 12 } });
        const input = { TYPE: 1, ITEM: 'DOGE:PEPE' };
        const out = await h.resolver.resolveActionParams('LIST', input);

        assert.strictEqual(out, input);
        assert.strictEqual(h.statusCalls(), 0);
        assert.deepStrictEqual(h.dogeCalls, []);
    });

    it('exposes the LS-90 gate reader on the SDK instance', async function () {
        const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        sdk.config.network = 'bitcoin-regtest';
        sdk.explorer = {
            coin: 'RBTC',
            async getStatus() { return { last_block: { RBTC: 0 } }; }
        };

        assert.strictEqual(typeof sdk.isListTickCoinActive, 'function');
        assert.strictEqual(await sdk.isListTickCoinActive(), await isListTickCoinActive(sdk));
        assert.strictEqual(await sdk.isListTickCoinActive(), true);
    });
});
