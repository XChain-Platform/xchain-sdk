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

const { expect } = require('chai');
const sinon   = require('sinon');
const XChainSDK = require('../../../src/XChainSDK.js');

// Helpers

// Env vars the SDK reads: clear them so tests are deterministic
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

// Build a minimal SDK pointed at a local regtest stack so no public
// defaults + no auto-hub are injected
function makeSDK(extra = {}) {
    return new XChainSDK(Object.assign({
        network:     'bitcoin-regtest',
        explorerUrl: 'http://localhost:8080',
        encoderUrl:  'http://localhost:3000',
        retry: false
    }, extra));
}

// Patch all explorer methods with a spy that resolves to {}
function mockExplorer(sdk, returnVal = {}) {
    const explorer = sdk.explorer;
    const proto = Object.getPrototypeOf(explorer);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof explorer[m] === 'function') {
            sinon.stub(explorer, m).resolves(returnVal);
        }
    }
    return explorer;
}

function registerEnvHooks() {
    let saved;
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}


    // Query/type-shaped explorer readers re-exported at the SDK top level
    const queryMethods = [
        'getMempool', 'getOrderCancels', 'getSwapCancels', 'getDispenserCancels',
        'getOrderMatches', 'getOrderEdits', 'getOrderExpires',
        'getSwapEdits', 'getSwapExpires',
        'getDispenserCloses', 'getDispenserEdits', 'getDispenserExpires'
    ];

describe('XChainSDK', function () {
    registerEnvHooks();

    // Explorer query re-exports

    describe('explorer query re-exports', function () {

        for (const method of queryMethods) {
            it(method + '() delegates to explorer.' + method, async function () {
                const sdk = makeSDK();
                const explorer = mockExplorer(sdk, { ok: true });
                const result = await sdk[method]('query1', 'address', { limit: 5 });
                expect(explorer[method].calledOnceWithExactly('query1', 'address', { limit: 5 })).to.be.true;
                expect(result).to.deep.equal({ ok: true });
            });
        }

        it('getNetwork() delegates to explorer.getNetwork', async function () {
            const sdk = makeSDK();
            const explorer = mockExplorer(sdk, { finality: { BTC: 6 } });
            const result = await sdk.getNetwork({ verbose: true });
            expect(explorer.getNetwork.calledOnceWithExactly({ verbose: true })).to.be.true;
            expect(result).to.deep.equal({ finality: { BTC: 6 } });
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('explorer query re-exports', function () {

        // explorer.js carried all four BET reads while the SDK top level
        // carried none, and neither side's unit tests could see the hole - this
        // suite mocks the ExplorerClient (so it only ever proves the client has
        // the method), and consumers mock the SDK (so a mock has whatever the
        // test defines). Every betting read in the wallet threw
        // "sdk.getBetFeeds is unavailable" against a real stack. These assert the
        // delegation itself, arguments included.
        it('getBetFeeds() delegates to explorer.getBetFeeds', async function () {
            const sdk = makeSDK();
            const explorer = mockExplorer(sdk, { data: [] });
            const result = await sdk.getBetFeeds('open', 'status', { limit: 5 });
            expect(explorer.getBetFeeds.calledOnceWithExactly('open', 'status', { limit: 5 })).to.be.true;
            expect(result).to.deep.equal({ data: [] });
        });

        it('getBetFeed() delegates with the feed index, not a query/type pair', async function () {
            const sdk = makeSDK();
            const explorer = mockExplorer(sdk, { action_index: '77' });
            const result = await sdk.getBetFeed(77, { verbose: true });
            expect(explorer.getBetFeed.calledOnceWithExactly(77, { verbose: true })).to.be.true;
            expect(result).to.deep.equal({ action_index: '77' });
        });

        it('getBets() delegates to explorer.getBets', async function () {
            const sdk = makeSDK();
            const explorer = mockExplorer(sdk, { data: [] });
            await sdk.getBets('1abc', 'address', { limit: 10 });
            expect(explorer.getBets.calledOnceWithExactly('1abc', 'address', { limit: 10 })).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('explorer query re-exports', function () {

        it('getOracleStats() delegates with a bare address', async function () {
            const sdk = makeSDK();
            const explorer = mockExplorer(sdk, { resolved: 3 });
            await sdk.getOracleStats('1oracle', {});
            expect(explorer.getOracleStats.calledOnceWithExactly('1oracle', {})).to.be.true;
        });

        it('throws EXPLORER_NOT_CONFIGURED when no explorer is wired', async function () {
            const sdk = makeSDK();
            sdk.explorer = null;
            for (const method of [...queryMethods, 'getNetwork',
                'getBetFeeds', 'getBetFeed', 'getBets', 'getOracleStats']) {
                try {
                    await sdk[method]('q', 'address');
                    expect.fail(method + ' should throw');
                } catch (e) {
                    expect(e.code).to.equal('EXPLORER_NOT_CONFIGURED');
                }
            }
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // Hub methods

    describe('hub methods', function () {

        it('pingHub throws when hub not configured', async function () {
            const sdk = makeSDK();
            expect(sdk.hub).to.equal(null);
            try {
                await sdk.pingHub();
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('HUB_NOT_CONFIGURED');
            }
        });

        it('pingHub delegates to hub.ping when configured', async function () {
            const sdk = makeSDK();
            sdk.hub = { ping: sinon.stub().resolves(true) };
            const result = await sdk.pingHub();
            expect(result).to.be.true;
        });

        it('getHubConfig returns null when no hub', function () {
            const sdk = makeSDK();
            expect(sdk.getHubConfig()).to.equal(null);
        });

        it('getHubConfig returns hub.configs when hub configured', function () {
            const sdk = makeSDK();
            sdk.hub = { configs: { foo: 'bar' } };
            const result = sdk.getHubConfig();
            expect(result).to.deep.equal({ foo: 'bar' });
        });

        it('getCapabilityThresholds returns null when no hub', async function () {
            const sdk = makeSDK();
            expect(sdk.hub).to.equal(null);
            expect(await sdk.getCapabilityThresholds()).to.equal(null);
        });

        it('getCapabilityThresholds delegates to hub when configured', async function () {
            const sdk = makeSDK();
            const rows = [{ capability: 'price', min_stake: '1000', disabled: false }];
            sdk.hub = { getCapabilityThresholds: sinon.stub().resolves(rows) };
            const result = await sdk.getCapabilityThresholds();
            expect(result).to.deep.equal(rows);
        });
    });
});
