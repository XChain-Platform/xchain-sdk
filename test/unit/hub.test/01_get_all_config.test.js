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
const HubConnector = require('../../../src/clients/hub.js');

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
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
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
            // watermark itself: the hub's cursor is inclusive (`>=`, item #2265), but an
            // older hub compared `>` on whole-second time and would exclude a row
            // upserted in the watermark's second forever. Overlapping one second keeps
            // the delta loss-free against either; the merge is idempotent, so
            // re-merging costs nothing.
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
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
        it('re-requests the boundary second so a same-second config write is not lost @regression', async function () {
            // An older hub filtered with a strict `>` on WHOLE-SECOND time (the current
            // hub compares `>=`, item #2265). A row upserted in the same epoch-second as
            // the watermark read (here: second 1000, written after the hub computed
            // MAX(updated_at)=1000) was excluded by `> 1000` and the watermark stayed
            // 1000, so under the old cursor it was NEVER delivered by delta and the SDK
            // served the stale value until restart. The -1 overlap guards that skew.
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
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
        it('binds the delta cursor to its origin endpoint: a failover target gets since_updated_at 0 and replaces the cache @regression', async function () {
            // A wall-clock cursor from hub A is meaningless against hub B (each hub
            // stamps updated_at = NOW() at its own apply time): B's rows stamped before
            // A's watermark would fall below the cursor and never arrive, and the merge
            // would keep A-era values while lastFetch reads fresh.
            let hub = new HubConnector({
                hubValidators: ['http://localhost:10000', 'http://hub2.test:8001']
            });
            nock(HUB_BASE)
                .post('/', body => body.params.since_updated_at === 0)
                .reply(200, { jsonrpc: '2.0', result: { configs: FULL_CONFIGS, seq: 1, watermark: 1000 }, id: 1 });
            await hub.getAllConfig();
            assert.strictEqual(hub.lastWatermark, 1000);
            assert.strictEqual(hub._watermarkEndpointIdx, 0);

            // Poll 2: A is down, B answers. B must be asked for the FULL tree.
            nock(HUB_BASE).post('/').replyWithError('timeout');
            let sentToB = null;
            nock(HUB2_BASE)
                .post('/', body => { sentToB = body.params.since_updated_at; return true; })
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { configs: { litecoin: { testnet: { 'xchain-encoder': { host: 'b-enc.test' } } } }, seq: 2, watermark: 2000 },
                    id: 1
                });
            let configs = await hub.getAllConfig();
            assert.strictEqual(sentToB, 0, 'failover target must receive since_updated_at 0, not A\'s cursor');
            // Full replace from B: A's cached branch is gone (never cross-hub merged).
            assert.ok(configs.litecoin);
            assert.strictEqual(configs.bitcoin, undefined);
            assert.strictEqual(hub.lastWatermark, 2000);
            assert.strictEqual(hub._lastGoodIdx, 1);
            assert.strictEqual(hub._watermarkEndpointIdx, 1);

            // Poll 3: B still answering; now the cursor is valid against B and a
            // delta (watermark - 1) is sent and merged.
            let sentToB3 = null;
            nock(HUB2_BASE)
                .post('/', body => { sentToB3 = body.params.since_updated_at; return true; })
                .reply(200, {
                    jsonrpc: '2.0',
                    result: { configs: { dogecoin: { mainnet: { 'xchain-encoder': { host: 'doge.test' } } } }, seq: 3, watermark: 2500 },
                    id: 1
                });
            let merged = await hub.getAllConfig();
            assert.strictEqual(sentToB3, 1999);
            assert.ok(merged.litecoin);
            assert.ok(merged.dogecoin);
        });
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
        it('treats a regressed hub watermark as a hub reset: alarms, drops the cache and re-fetches the full tree @regression', async function () {
            // Hub restored from an older snapshot: watermark goes BACKWARDS. The delta
            // against the lost-window cursor cannot carry rows the restored hub holds
            // at an older updated_at, and the upsert-only merge would serve lost-window
            // values forever with lastFetch reading fresh.
            nock(HUB_BASE)
                .post('/', body => body.params.since_updated_at === 0)
                .reply(200, { jsonrpc: '2.0', result: { configs: {
                    bitcoin: { mainnet: { 'xchain-encoder': { host: 'lost-window.test', port: '3000' } } }
                }, seq: 5, watermark: 5000 }, id: 1 });
            let hub = new HubConnector();
            await hub.getAllConfig();
            assert.strictEqual(hub.lastWatermark, 5000);

            // Poll 2: delta at 4999 comes back EMPTY with a LOWER watermark (3000).
            nock(HUB_BASE)
                .post('/', body => body.params.since_updated_at === 4999)
                .reply(200, { jsonrpc: '2.0', result: { configs: {}, seq: 3, watermark: 3000 }, id: 1 });
            // The connector must then re-fetch the full tree from the same endpoint.
            let refetched = false;
            nock(HUB_BASE)
                .post('/', body => { if (body.params.since_updated_at === 0) { refetched = true; return true; } return false; })
                .reply(200, { jsonrpc: '2.0', result: { configs: FULL_CONFIGS, seq: 3, watermark: 3000 }, id: 1 });

            let errors = [];
            let origError = console.error;
            console.error = (...args) => { errors.push(args.join(' ')); };
            let configs;
            try {
                configs = await hub.getAllConfig();
            } finally {
                console.error = origError;
            }
            assert.ok(refetched, 'expected a since_updated_at=0 full re-fetch after the regression');
            // The lost-window value is gone: the restored hub's tree replaced the cache.
            assert.strictEqual(configs.bitcoin.mainnet['xchain-encoder'].host, 'encoder.test');
            assert.strictEqual(hub.lastWatermark, 3000);
            assert.strictEqual(hub.lastSeq, 3);
            assert.ok(errors.some(e => /HUB CONFIG REGRESSION/.test(e)), 'regression must be alarmed at error level');

            // Poll 3: steady state resumes as a delta against the new watermark.
            let sent = null;
            nock(HUB_BASE)
                .post('/', body => { sent = body.params.since_updated_at; return true; })
                .reply(200, { jsonrpc: '2.0', result: { configs: {}, seq: 3, watermark: 3000 }, id: 1 });
            await hub.getAllConfig();
            assert.strictEqual(sent, 2999);
        });
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
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
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
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
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('getAllConfig()', function () {
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
});
