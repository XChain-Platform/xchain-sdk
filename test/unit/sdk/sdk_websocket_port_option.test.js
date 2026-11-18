// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// A websocketPort option given without a URL must not be dropped in favour of the
// public explorer host: the client ignores a port once its URL has a scheme.

const { expect } = require('chai');
const XChainSDK = require('../../../src/XChainSDK.js');

const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];
let saved;

describe('XChainSDK websocketPort option', function () {
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('points a websocketPort given alone at localhost, not the public explorer host', function () {
        const sdk = new XChainSDK({ network: 'bitcoin-mainnet', websocketPort: 18081 });
        expect(sdk.ws.baseUrl).to.equal('localhost');
        expect(sdk.ws.port).to.equal(18081);
        expect(sdk.explorer.client.defaults.baseURL).to.equal('https://explorer.xchain.io');
    });

    it('lets a websocketPort option follow an explicit explorer URL', function () {
        const sdk = new XChainSDK({ network: 'bitcoin-mainnet', explorerUrl: 'explorer.opt.example', websocketPort: 18081 });
        expect(sdk.ws.baseUrl).to.equal('explorer.opt.example');
        expect(sdk.ws.port).to.equal(18081);
    });

    it('lets a websocketPort option follow an explorer URL from the environment', function () {
        process.env.EXPLORER_URL = 'explorer.env.example';
        const sdk = new XChainSDK({ network: 'bitcoin-mainnet', websocketPort: 18081 });
        expect(sdk.ws.baseUrl).to.equal('explorer.env.example');
        expect(sdk.ws.port).to.equal(18081);
    });

    it('keeps a websocketPort-only client on localhost after hub discovery', async function () {
        const sdk = new XChainSDK({ network: 'bitcoin-mainnet', websocketPort: 18081 });
        sdk.hub.getDiscoveryConfig = async () => ({});
        sdk.hub.extractServiceEndpoints = () => ({ explorerUrl: 'https://explorer.xchain.io' });
        sdk.hub.startPolling = () => {};
        await sdk.ensureReady();
        expect(sdk.ws.baseUrl).to.equal('localhost');
        expect(sdk.ws.port).to.equal(18081);
    });
});
