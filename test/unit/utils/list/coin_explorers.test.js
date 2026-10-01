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
const { COIN_NETWORK_PREFIX, buildCoinExplorers } = require('../../../../src/utils/list/coin_explorers.js');

class FakeClient {
    constructor(options) { this.options = options; }
}

const base = { baseUrl: 'http://explorer.test', port: 4000, timeout: 1234, retry: { attempts: 2 }, hooks: { onRequest() {} } };

describe('coin_explorers', () => {
    it('maps each coin to its network prefix', () => {
        assert.deepStrictEqual(COIN_NETWORK_PREFIX, { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' });
    });

    it('returns BTC, LTC, DOGE in order with network strings', () => {
        const out = buildCoinExplorers(base, 'regtest', FakeClient);
        assert.deepStrictEqual(out.map(e => e.chain), ['BTC', 'LTC', 'DOGE']);
        assert.deepStrictEqual(out.map(e => e.explorer.options.network),
            ['bitcoin-regtest', 'litecoin-regtest', 'dogecoin-regtest']);
        out.forEach(e => assert.ok(e.explorer instanceof FakeClient));
    });

    it('copies url, port, timeout, retry and hooks', () => {
        for (const { explorer } of buildCoinExplorers(base, 'regtest', FakeClient)) {
            assert.strictEqual(explorer.options.explorerUrl, base.baseUrl);
            assert.strictEqual(explorer.options.explorerPort, base.port);
            assert.strictEqual(explorer.options.timeout, base.timeout);
            assert.strictEqual(explorer.options.retry, base.retry);
            assert.strictEqual(explorer.options.hooks, base.hooks);
        }
    });

    it('honours a different tier', () => {
        const out = buildCoinExplorers(base, 'mainnet', FakeClient);
        assert.deepStrictEqual(out.map(e => e.explorer.options.network),
            ['bitcoin-mainnet', 'litecoin-mainnet', 'dogecoin-mainnet']);
    });
});
