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
const http = require('http');
const https = require('https');
const sinon = require('sinon');
const ExplorerClient = require('../../../../src/clients/explorer.js');
const TickResolver = require('../../../../src/utils/tick_resolver.js');
const Utility = require('../../../../src/utils/utility.js');
const walletAndMessages = require('../../../../src/XChainSDK/wallet_and_messages.js');
const { COIN_NETWORK_PREFIX, buildCoinExplorers } = require('../../../../src/utils/list/coin_explorers.js');

class FakeClient {
    constructor(options) { this.options = options; }
}

const base = { baseUrl: 'http://explorer.test', port: 4000, timeout: 1234, retry: { attempts: 2 }, hooks: { onRequest() {} } };

// The agent a sibling client actually dials through, read from its axios instance.
function dialAgent(client) {
    return client.client.defaults.httpsAgent || client.client.defaults.httpAgent;
}

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

    it('passes the given connection pool to every sibling client', () => {
        const pool = { httpsAgent: {} };
        for (const { explorer } of buildCoinExplorers(base, 'regtest', FakeClient, pool)) {
            assert.strictEqual(explorer.options.pool, pool);
        }
    });

    it('uses the injected agent in every real sibling client', () => {
        const agent = new https.Agent();
        const pool = { httpsAgent: agent };
        const realBase = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'https://explorer.test', pool });
        for (const { explorer } of buildCoinExplorers(realBase, 'regtest', ExplorerClient, pool)) {
            assert.strictEqual(dialAgent(explorer), agent);
        }
    });
});

describe('coin_explorers through the SDK callers', () => {
    it('routes cross-chain message lookups through the SDK pool', async () => {
        const agent = new https.Agent();
        const pool = { httpsAgent: agent };
        let seen = null;
        const sdk = {
            options: { network: 'bitcoin-regtest', pool },
            requireExplorer: () => new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'https://explorer.test', pool }),
            messaging: { getAllMessages: async (address, opts, explorers) => { seen = explorers; return []; } }
        };
        await walletAndMessages.getAllMessagesForAddress.call(sdk, 'addr1', {});
        assert.strictEqual(seen.length, 3);
        for (const { explorer } of seen) assert.strictEqual(dialAgent(explorer), agent);
    });

    it('routes cross-chain LIST ticker lookups through the SDK pool', async () => {
        const agent = new http.Agent();
        const dialed = [];
        const getToken = sinon.stub(ExplorerClient.prototype, 'getToken').callsFake(async function () {
            dialed.push(dialAgent(this));
            return { info: { tick_id: 12 } };
        });
        try {
            const explorer = {
                coin: 'RBTC',
                async getStatus() { return { last_block: { RBTC: 0 } }; },
                async getToken() { return null; }
            };
            const resolver = new TickResolver({
                options: { network: 'bitcoin-regtest', pool: { httpAgent: agent } },
                config: { network: 'bitcoin-regtest' }, util: new Utility(), explorer
            });
            const out = await resolver.resolveActionParams('LIST', { TYPE: '1', ITEM: ['DOGE:PEPE'] });
            assert.deepStrictEqual(out.ITEM, ['DOGE:^12']);
            assert.deepStrictEqual(dialed, [agent]);
        } finally {
            getToken.restore();
        }
    });
});
