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
const HubConnector = require('../../../../src/clients/hub.js');

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
    });
});

describe('HubConnector', function () {

    afterEach(function () {
        nock.cleanAll();
    });

    describe('extractServiceEndpoints()', function () {
        let hub;
        beforeEach(function () {
            hub = new HubConnector();
            hub.configs = FULL_CONFIGS;
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
});
