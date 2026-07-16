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
const nock = require('nock');
const HubConnector = require('../../src/hub.js');

const HUB_BASE = 'http://localhost:10000';
const HUB2_BASE = 'http://hub2.test:8001';

// Full config tree returned by hub
const FULL_CONFIGS = {
    bitcoin: {
        mainnet: {
            'xchain-encoder': { host: 'encoder.test', port: '3000' },
            'xchain-explorer': { host: 'explorer.test', port: '8080' }
        }
    }
};

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    /*
     *  Constructor
     */

    describe('constructor', function () {
        it('defaults to localhost:10000', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.url, 'http://localhost:10000');
            assert.deepStrictEqual(hub.urls, ['http://localhost:10000']);
        });

        it('uses hubUrl + hubPort', function () {
            let hub = new HubConnector({ hubUrl: 'hub.test', hubPort: 9000 });
            assert.strictEqual(hub.url, 'http://hub.test:9000');
        });

        it('prepends http:// when missing', function () {
            let hub = new HubConnector({ hubUrl: 'hub.test', hubPort: 8001 });
            assert.ok(hub.url.startsWith('http://'));
        });

        it('keeps http:// prefix from hubUrl as-is', function () {
            let hub = new HubConnector({ hubUrl: 'http://custom.test', hubPort: 9999 });
            assert.strictEqual(hub.url, 'http://custom.test');
        });

        it('uses hubValidators array when provided', function () {
            let hub = new HubConnector({
                hubValidators: ['hub1.test:8001', 'http://hub2.test:8001']
            });
            assert.strictEqual(hub.urls.length, 2);
            assert.ok(hub.urls[0].startsWith('http://'));
            assert.ok(hub.urls[1].startsWith('http://'));
            assert.strictEqual(hub.url, hub.urls[0]);
        });

        it('falls back to hubUrl when hubValidators is empty array', function () {
            let hub = new HubConnector({ hubValidators: [], hubUrl: 'fallback.test', hubPort: 8001 });
            assert.strictEqual(hub.urls.length, 1);
        });

        it('falls back to hubUrl when hubValidators is not an array', function () {
            let hub = new HubConnector({ hubValidators: 'not-an-array', hubUrl: 'fallback.test', hubPort: 8001 });
            assert.strictEqual(hub.urls.length, 1);
        });

        it('sets default timeout to 5000', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.timeout, 5000);
        });

        it('accepts custom timeout', function () {
            let hub = new HubConnector({ timeout: 10000 });
            assert.strictEqual(hub.timeout, 10000);
        });

        it('sets default pollInterval to 60000', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.pollInterval, 60000);
        });

        it('accepts custom pollInterval', function () {
            let hub = new HubConnector({ hubPollInterval: 30000 });
            assert.strictEqual(hub.pollInterval, 30000);
        });

        it('initializes configs as null and lastSeq as 0', function () {
            let hub = new HubConnector();
            assert.strictEqual(hub.configs, null);
            assert.strictEqual(hub.lastSeq, 0);
            assert.strictEqual(hub.lastWatermark, 0);
        });
    });

    /*
     *  getAllConfig()
     */

    describe('getAllConfig()', function () {
        it('fetches configs from hub (bare map response)', async function () {
            nock(HUB_BASE)
                .post('/', body => body.method === 'getallconfigs')
                .reply(200, { jsonrpc: '2.0', result: FULL_CONFIGS, id: 1 });

            let hub = new HubConnector();
            let configs = await hub.getAllConfig();
            assert.ok(configs.bitcoin);
            assert.ok(configs.bitcoin.mainnet);
            assert.strictEqual(hub.lastFetch !== null, true);
            assert.strictEqual(hub.lastSeq, 0);   // bare map → seq stays 0
            assert.strictEqual(hub.lastWatermark, 0);
        });

        it('fetches configs with wrapped {configs, seq} response', async function () {
            nock(HUB_BASE)
                .post('/', body => body.method === 'getallconfigs')
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { configs: FULL_CONFIGS, seq: 42 },
                    id: 1
                });

            let hub = new HubConnector();
            let configs = await hub.getAllConfig();
            assert.ok(configs.bitcoin);
            assert.strictEqual(hub.lastSeq, 42);
            assert.strictEqual(hub.lastWatermark, 0); // no watermark in response
        });

        it('fetches and merges delta when watermark present', async function () {
            // First: full fetch (no cursor sent)
            nock(HUB_BASE)
                .post('/', body => body.method === 'getallconfigs' && body.params.since_updated_at === 0)
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { configs: FULL_CONFIGS, seq: 1, watermark: 1000 },
                    id: 1
                });

            let hub = new HubConnector();
            await hub.getAllConfig();
            assert.strictEqual(hub.lastWatermark, 1000);

            // Second: delta fetch. The cursor sent is watermark-1 (999), not the
            // watermark itself: the hub's cursor is a strict `>` on whole-second time,
            // so a row upserted in the same epoch-second as the watermark read would be
            // excluded by `> 1000` forever. Overlapping one second re-delivers it; the
            // merge is idempotent, so re-merging costs nothing.
            nock(HUB_BASE)
                .post('/', body => body.params.since_updated_at === 999)
                .reply(200, {
                    jsonrpc: '2.0',
                    result: {
                        configs: { dogecoin: { mainnet: { 'xchain-encoder': { host: 'doge-enc.test', port: '4000' } } } },
                        seq: 2,
                        watermark: 2000
                    },
                    id: 1
                });

            let configs = await hub.getAllConfig();
            // Merged: bitcoin still present, dogecoin added
            assert.ok(configs.bitcoin);
            assert.ok(configs.dogecoin);
            assert.strictEqual(hub.lastWatermark, 2000);
        });

        it('re-requests the boundary second so a same-second config write is not lost @regression', async function () {
            // The hub filters with a strict `>` on WHOLE-SECOND time. A row upserted in
            // the same epoch-second as the watermark read (here: second 1000, written
            // after the hub computed MAX(updated_at)=1000) is excluded by `> 1000` and
            // the watermark stays 1000, so under the old cursor it was NEVER delivered
            // by delta and the SDK served the stale value until restart.
            nock(HUB_BASE)
                .post('/', body => body.params.since_updated_at === 0)
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { configs: FULL_CONFIGS, seq: 1, watermark: 1000 },
                    id: 1
                });

            let hub = new HubConnector();
            await hub.getAllConfig();
            assert.strictEqual(hub.lastWatermark, 1000);

            // The delta poll must ask from 999, so the second-1000 row is re-scanned.
            let sentCursor = null;
            nock(HUB_BASE)
                .post('/', body => { sentCursor = body.params.since_updated_at; return true; })
                .reply(200, {
                    jsonrpc: '2.0',
                    result: {
                        configs: { bitcoin: { mainnet: { 'xchain-encoder': { host: 'late-write.test' } } } },
                        seq: 2,
                        watermark: 1000
                    },
                    id: 1
                });

            let configs = await hub.getAllConfig();
            assert.strictEqual(sentCursor, 999, 'must overlap the boundary second, not send the watermark');
            // The same-second write is delivered and merged rather than stranded.
            assert.strictEqual(configs.bitcoin.mainnet['xchain-encoder'].host, 'late-write.test');
        });

        it('sends since_updated_at: 0 on first call', async function () {
            let sentPayload;
            nock(HUB_BASE)
                .post('/', body => { sentPayload = body; return true; })
                .reply(200, { jsonrpc: '2.0', result: FULL_CONFIGS, id: 1 });

            let hub = new HubConnector();
            await hub.getAllConfig();
            assert.strictEqual(sentPayload.params.since_updated_at, 0);
        });

        it('throws SDKHubError when all endpoints fail', async function () {
            nock(HUB_BASE).post('/').replyWithError('connection refused');

            let hub = new HubConnector();
            try {
                await hub.getAllConfig();
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKHubError');
                assert.strictEqual(e.code, 'HUB_UNAVAILABLE');
                assert.ok(e.message.includes('1 endpoint'));
            }
        });

        it('throws SDKHubError when result is missing', async function () {
            nock(HUB_BASE).post('/').reply(200, { jsonrpc: '2.0', id: 1 });

            let hub = new HubConnector();
            try {
                await hub.getAllConfig();
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKHubError');
            }
        });

        it('tries next endpoint when first fails (multi-endpoint)', async function () {
            nock(HUB_BASE).post('/').replyWithError('timeout');
            nock(HUB2_BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: FULL_CONFIGS, id: 1 });

            let hub = new HubConnector({
                hubValidators: ['http://localhost:8001', 'http://hub2.test:8001']
            });
            let configs = await hub.getAllConfig();
            assert.ok(configs.bitcoin);
            // _lastGoodIdx should point to hub2
            assert.strictEqual(hub._lastGoodIdx, 1);
        });

        it('throws when all multi-endpoints fail', async function () {
            nock(HUB_BASE).post('/').replyWithError('timeout');
            nock(HUB2_BASE).post('/').replyWithError('timeout');

            let hub = new HubConnector({
                hubValidators: ['http://localhost:8001', 'http://hub2.test:8001']
            });
            try {
                await hub.getAllConfig();
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKHubError');
                assert.ok(e.message.includes('2 endpoint'));
            }
        });

        it('handles result with null configs key gracefully', async function () {
            // When result.configs is null, the wrapped-format guard fails (null is falsy),
            // so the whole result object is treated as a bare config map (else branch).
            // Bare map path → no watermark → payload returned as-is (or {} if falsy).
            // result itself is truthy, so configs = result (the whole object).
            nock(HUB_BASE)
                .post('/')
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { configs: null, seq: 1, watermark: 500 },
                    id: 1
                });

            let hub = new HubConnector();
            let configs = await hub.getAllConfig();
            // The bare-map fallback returns the result object itself (not {})
            assert.ok(configs !== null);
            assert.strictEqual(hub.lastWatermark, 0); // bare map → watermark reset to 0
        });
    });

    /*
     *  ping()
     */

    describe('ping()', function () {
        it('returns true when hub responds', async function () {
            nock(HUB_BASE)
                .post('/', body => body.method === 'ping')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            let hub = new HubConnector();
            let ok = await hub.ping();
            assert.strictEqual(ok, true);
        });

        it('returns false when all endpoints fail', async function () {
            nock(HUB_BASE).post('/').replyWithError('connection refused');

            let hub = new HubConnector();
            let ok = await hub.ping();
            assert.strictEqual(ok, false);
        });

        it('returns false when response has no result', async function () {
            nock(HUB_BASE).post('/').reply(200, { jsonrpc: '2.0', id: 1 });

            let hub = new HubConnector();
            let ok = await hub.ping();
            assert.strictEqual(ok, false);
        });

        it('tries next endpoint on failure (multi-endpoint)', async function () {
            nock(HUB_BASE).post('/').replyWithError('timeout');
            nock(HUB2_BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            let hub = new HubConnector({
                hubValidators: ['http://localhost:8001', 'http://hub2.test:8001']
            });
            let ok = await hub.ping();
            assert.strictEqual(ok, true);
            assert.strictEqual(hub._lastGoodIdx, 1);
        });
    });

    /*
     *  getCapabilityThresholds()
     */

    describe('getCapabilityThresholds()', function () {
        const THRESHOLDS = [
            { capability: 'price', min_stake: '1000', disabled: false },
            { capability: 'cross_chain', min_stake: '5000', disabled: false }
        ];

        it('returns the thresholds array when the hub responds', async function () {
            nock(HUB_BASE)
                .post('/', body => body.method === 'getcapabilitythresholds')
                .reply(200, { jsonrpc: '2.0', result: { thresholds: THRESHOLDS }, id: 1 });

            let hub = new HubConnector();
            let rows = await hub.getCapabilityThresholds();
            assert.deepStrictEqual(rows, THRESHOLDS);
        });

        it('returns null when all endpoints fail', async function () {
            nock(HUB_BASE).post('/').replyWithError('connection refused');

            let hub = new HubConnector();
            let rows = await hub.getCapabilityThresholds();
            assert.strictEqual(rows, null);
        });

        it('returns null when result lacks a thresholds array', async function () {
            nock(HUB_BASE).post('/').reply(200, { jsonrpc: '2.0', result: { error: 'nope' }, id: 1 });

            let hub = new HubConnector();
            let rows = await hub.getCapabilityThresholds();
            assert.strictEqual(rows, null);
        });

        it('tries next endpoint on failure (multi-endpoint)', async function () {
            nock(HUB_BASE).post('/').replyWithError('timeout');
            nock(HUB2_BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { thresholds: THRESHOLDS }, id: 1 });

            let hub = new HubConnector({
                hubValidators: ['http://localhost:8001', 'http://hub2.test:8001']
            });
            let rows = await hub.getCapabilityThresholds();
            assert.deepStrictEqual(rows, THRESHOLDS);
            assert.strictEqual(hub._lastGoodIdx, 1);
        });
    });

    /*
     *  extractServiceEndpoints()
     */

    describe('extractServiceEndpoints()', function () {
        let hub;
        beforeEach(function () {
            hub = new HubConnector();
            hub.configs = FULL_CONFIGS;
        });

        it('returns encoder and explorer endpoints for known network', function () {
            let endpoints = hub.extractServiceEndpoints('bitcoin-mainnet');
            assert.strictEqual(endpoints.encoderUrl, 'encoder.test');
            assert.strictEqual(endpoints.encoderPort, 3000);
            assert.strictEqual(endpoints.explorerUrl, 'explorer.test');
            assert.strictEqual(endpoints.explorerPort, 8080);
        });

        it('returns {} when configs is null', function () {
            hub.configs = null;
            assert.deepStrictEqual(hub.extractServiceEndpoints('bitcoin-mainnet'), {});
        });

        it('returns {} when network is null/undefined', function () {
            assert.deepStrictEqual(hub.extractServiceEndpoints(null), {});
            assert.deepStrictEqual(hub.extractServiceEndpoints(undefined), {});
        });

        it('returns {} for unknown network string', function () {
            assert.deepStrictEqual(hub.extractServiceEndpoints('ethereum-mainnet'), {});
        });

        it('returns {} when coin not in configs', function () {
            hub.configs = {}; // no bitcoin key
            assert.deepStrictEqual(hub.extractServiceEndpoints('bitcoin-mainnet'), {});
        });

        it('returns {} when network not in coin config', function () {
            hub.configs = { bitcoin: {} }; // no mainnet key
            assert.deepStrictEqual(hub.extractServiceEndpoints('bitcoin-mainnet'), {});
        });

        it('uses service_port when present (overrides port)', function () {
            hub.configs = {
                bitcoin: {
                    mainnet: {
                        'xchain-encoder': { host: 'enc.test', port: '3000', service_port: '4000' }
                    }
                }
            };
            let endpoints = hub.extractServiceEndpoints('bitcoin-mainnet');
            assert.strictEqual(endpoints.encoderPort, 4000);
        });

        it('falls back to shared explorer from another coin/network', function () {
            hub.configs = {
                bitcoin: {
                    mainnet: {
                        'xchain-encoder': { host: 'enc.test', port: '3000' }
                        // no xchain-explorer here
                    }
                },
                litecoin: {
                    mainnet: {
                        'xchain-explorer': { host: 'shared-explorer.test', port: '8080' }
                    }
                }
            };
            let endpoints = hub.extractServiceEndpoints('bitcoin-mainnet');
            assert.strictEqual(endpoints.explorerUrl, 'shared-explorer.test');
        });

        it('supports all 9 networks', function () {
            const networks = [
                'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
                'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest',
                'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest'
            ];
            hub.configs = {};
            for (let n of networks) {
                let result = hub.extractServiceEndpoints(n);
                assert.deepStrictEqual(result, {}); // empty but no throw
            }
        });
    });

    /*
     *  startPolling() / stopPolling()
     */

    describe('startPolling() / stopPolling()', function () {
        it('stopPolling() is a no-op when not started', function () {
            let hub = new HubConnector();
            assert.doesNotThrow(() => hub.stopPolling());
            assert.strictEqual(hub._pollTimer, null);
        });

        it('startPolling() sets _pollTimer', function () {
            let hub = new HubConnector({ hubPollInterval: 60000 });
            // stub getAllConfig so it doesn't actually hit the net
            hub.getAllConfig = async () => ({});
            hub.startPolling();
            assert.ok(hub._pollTimer !== null);
            hub.stopPolling();
        });

        it('startPolling() is idempotent (does not double-start)', function () {
            let hub = new HubConnector({ hubPollInterval: 60000 });
            hub.getAllConfig = async () => ({});
            hub.startPolling();
            let t1 = hub._pollTimer;
            hub.startPolling(); // second call is a no-op
            assert.strictEqual(hub._pollTimer, t1);
            hub.stopPolling();
        });

        it('stopPolling() clears the timer', function () {
            let hub = new HubConnector({ hubPollInterval: 60000 });
            hub.getAllConfig = async () => ({});
            hub.startPolling();
            hub.stopPolling();
            assert.strictEqual(hub._pollTimer, null);
        });
    });

});
