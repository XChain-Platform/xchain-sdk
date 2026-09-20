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
const nock = require('nock');
const HubConnector = require('../../../../src/clients/hub.js');
const XChainSDK = require('../../../../src/XChainSDK.js');

const HUB_BASE = 'http://localhost:10000';
const REGISTRY_PATH = '/api/v1/chain-registry';

function descriptor(overrides = {}) {
    return Object.assign({
        id: 'bitcoin-mainnet',
        coin: 'bitcoin',
        networkKind: 'mainnet',
        explorer: { defaultUrl: 'https://discovered-explorer.test', defaultPort: 8443 },
        encoder: { defaultUrl: 'https://discovered-encoder.test/BTC', defaultPort: 9443 }
    }, overrides);
}

describe('public hub discovery', function () {
    let savedHubApiKey;

    beforeEach(function () {
        savedHubApiKey = process.env.HUB_API_KEY;
        delete process.env.HUB_API_KEY;
    });

    afterEach(function () {
        nock.cleanAll();
        if (savedHubApiKey === undefined) delete process.env.HUB_API_KEY;
        else process.env.HUB_API_KEY = savedHubApiKey;
    });

    it('uses public GET discovery, updates clients and getHubConfig(), then polls the same public route', async function () {
        let gets = 0;
        let sawPoll;
        let polled = new Promise(resolve => { sawPoll = resolve; });
        nock(HUB_BASE)
            .get(REGISTRY_PATH)
            .twice()
            .reply(200, () => {
                gets++;
                if (gets === 2) sawPoll();
                return { schema_version: 1, descriptors: [descriptor()] };
            });
        let forbiddenPost = nock(HUB_BASE)
            .post('/BTC', body => body && body.method === 'getallconfigs')
            .reply(500, { error: 'public clients must not call getallconfigs' });

        let sdk = new XChainSDK({
            network: 'bitcoin-mainnet',
            hubUrl: HUB_BASE + '/BTC',
            hubPollInterval: 10,
            retry: false
        });

        try {
            await sdk.discover();
            assert.strictEqual(sdk.explorer.baseUrl, 'https://discovered-explorer.test');
            assert.strictEqual(sdk.explorer.port, 8443);
            assert.strictEqual(sdk.encoder.baseUrl, 'https://discovered-encoder.test/BTC');
            assert.strictEqual(sdk.encoder.port, 9443);
            assert.deepStrictEqual(sdk.getHubConfig(), {
                bitcoin: {
                    mainnet: {
                        'xchain-explorer': { host: 'https://discovered-explorer.test', port: 8443 },
                        'xchain-encoder': { host: 'https://discovered-encoder.test/BTC', port: 9443 }
                    }
                }
            });
            assert.strictEqual(sdk._polling, true);
            assert.ok(sdk.hub._pollTimer, 'discovery must reach polling');
            await Promise.race([
                polled,
                new Promise((resolve, reject) => setTimeout(() => reject(new Error('poll did not use public discovery')), 500))
            ]);
            assert.strictEqual(gets, 2);
            assert.strictEqual(forbiddenPost.isDone(), false, 'keyless discovery must never POST getallconfigs');
        } finally {
            sdk.stop();
        }
    });

    it('fails over between hub origins and reports HUB_UNAVAILABLE when all public origins fail', async function () {
        nock(HUB_BASE).get(REGISTRY_PATH).replyWithError('first hub unavailable');
        nock('http://hub2.test:8001').get(REGISTRY_PATH)
            .reply(200, { descriptors: [descriptor()] });

        let hub = new HubConnector({
            hubValidators: [HUB_BASE + '/BTC', 'http://hub2.test:8001/TBTC']
        });
        let configs = await hub.getDiscoveryConfig();
        assert.ok(configs.bitcoin.mainnet);
        assert.strictEqual(hub._lastGoodIdx, 1);

        nock('http://bad-one.test').get(REGISTRY_PATH).replyWithError('offline');
        nock('http://bad-two.test').get(REGISTRY_PATH).reply(200, { descriptors: null });
        let unavailable = new HubConnector({
            hubValidators: ['http://bad-one.test/BTC', 'http://bad-two.test/TBTC']
        });
        await assert.rejects(
            unavailable.getDiscoveryConfig(),
            err => err.name === 'SDKHubError' && err.code === 'HUB_UNAVAILABLE' && /2 endpoint/.test(err.message)
        );
    });

    it('retains keyed getallconfigs JSON-RPC discovery', async function () {
        let publicGet = nock(HUB_BASE).get(REGISTRY_PATH)
            .reply(500, { error: 'keyed clients should retain JSON-RPC' });
        let rpc = nock(HUB_BASE, { reqheaders: { 'x-api-key': 'operator-key' } })
            .post('/', body => body.method === 'getallconfigs' && body.params.since_updated_at === 0)
            .reply(200, {
                jsonrpc: '2.0',
                result: { bitcoin: { mainnet: { 'xchain-encoder': { host: 'mesh-encoder.test' } } } },
                id: 1
            });

        let hub = new HubConnector({ hubUrl: HUB_BASE, hubApiKey: 'operator-key' });
        let configs = await hub.getDiscoveryConfig();
        assert.strictEqual(configs.bitcoin.mainnet['xchain-encoder'].host, 'mesh-encoder.test');
        assert.strictEqual(rpc.isDone(), true);
        assert.strictEqual(publicGet.isDone(), false);
    });
});
