// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const XChainSDK = require('../../src/XChainSDK.js');

// Endpoint env vars the SDK consults: cleared so tests are deterministic.
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

const exBase = (sdk) => sdk.explorer && sdk.explorer.client.defaults.baseURL;
const enBase = (sdk) => sdk.encoder && sdk.encoder.client.defaults.baseURL;

describe('XChainSDK config resolution', function () {
    let saved;
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

    describe('zero-config public defaults', function () {
        it('mainnet resolves to public coin-path hosts', function () {
            const sdk = new XChainSDK({ network: 'bitcoin-mainnet' });
            expect(exBase(sdk)).to.equal('https://explorer.xchain.io');   // client adds /{COIN}/api
            expect(enBase(sdk)).to.equal('https://encoder.xchain.io/BTC');
            expect(sdk.hub.url).to.equal('https://hub.xchain.io/BTC');
            expect(sdk.explorer.coin).to.equal('BTC');
        });

        it('testnet uses the T-prefixed coin', function () {
            const sdk = new XChainSDK({ network: 'litecoin-testnet' });
            expect(enBase(sdk)).to.equal('https://encoder.xchain.io/TLTC');
            expect(sdk.hub.url).to.equal('https://hub.xchain.io/TLTC');
        });

        it('regtest stays on localhost with no auto-hub', function () {
            const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
            expect(exBase(sdk)).to.equal('http://localhost:8080');
            expect(sdk.encoder).to.equal(null);
            expect(sdk.hub).to.equal(null);
        });
    });

    describe('resolution precedence', function () {
        it('explicit option beats the public default', function () {
            const sdk = new XChainSDK({ network: 'bitcoin-mainnet', explorerUrl: 'http://localhost:9999' });
            expect(exBase(sdk)).to.equal('http://localhost:9999');
            expect(enBase(sdk)).to.equal('https://encoder.xchain.io/BTC'); // untouched
        });

        it('env var beats the public default but loses to an option', function () {
            process.env.ENCODER_URL = 'https://enc.env.example';
            const a = new XChainSDK({ network: 'bitcoin-mainnet' });
            expect(enBase(a)).to.equal('https://enc.env.example');
            const b = new XChainSDK({ network: 'bitcoin-mainnet', encoderUrl: 'https://enc.opt.example' });
            expect(enBase(b)).to.equal('https://enc.opt.example');
        });
    });

    describe('lazy hub overlay (_ensureReady)', function () {
        // Build an SDK whose hub returns the given endpoints, with polling stubbed.
        function withHub(endpoints, getAllConfig) {
            const sdk = new XChainSDK({ network: 'bitcoin-mainnet' });
            sdk.hub.getAllConfig = getAllConfig || (async () => ({}));
            sdk.hub.extractServiceEndpoints = () => endpoints;
            sdk.hub.startPolling = () => {};
            return sdk;
        }

        it('overlays an https endpoint onto the live client', async function () {
            const sdk = withHub({ explorerUrl: 'https://explorer.internal', explorerPort: 9443 });
            await sdk._ensureReady();
            expect(exBase(sdk)).to.equal('https://explorer.internal');
        });

        it('is memoized: discovery runs at most once', async function () {
            let calls = 0;
            const sdk = withHub({ explorerUrl: 'https://explorer.internal' }, async () => { calls++; return {}; });
            await sdk._ensureReady();
            await sdk._ensureReady();
            expect(calls).to.equal(1);
        });

        it('swallows hub failure and keeps the hardcoded default', async function () {
            const sdk = withHub({}, async () => { throw new Error('hub down'); });
            let threw = false;
            try { await sdk._ensureReady(); } catch (e) { threw = true; }
            expect(threw).to.equal(false);
            expect(exBase(sdk)).to.equal('https://explorer.xchain.io');
        });

        it('no hub (regtest) -> _ensureReady is a no-op', async function () {
            const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
            await sdk._ensureReady();
            expect(exBase(sdk)).to.equal('http://localhost:8080');
        });
    });

    describe('downgrade guard', function () {
        function applyHub(opts, endpoints) {
            const sdk = new XChainSDK(Object.assign({ network: 'bitcoin-mainnet' }, opts));
            sdk.hub.getAllConfig = async () => ({});
            sdk.hub.extractServiceEndpoints = () => endpoints;
            sdk.hub.startPolling = () => {};
            return sdk._ensureReady().then(() => sdk);
        }

        it('does NOT downgrade an https default to a bare host', async function () {
            const sdk = await applyHub({}, { explorerUrl: 'explorer.internal', explorerPort: 18080 });
            expect(exBase(sdk)).to.equal('https://explorer.xchain.io');
        });

        it('does NOT downgrade an https default to an http URL', async function () {
            const sdk = await applyHub({}, { explorerUrl: 'http://explorer.internal:18080' });
            expect(exBase(sdk)).to.equal('https://explorer.xchain.io');
        });

        it('allowInsecureEndpoints:true opts out of the guard', async function () {
            const sdk = await applyHub({ allowInsecureEndpoints: true }, { explorerUrl: 'explorer.internal', explorerPort: 18080 });
            expect(exBase(sdk)).to.equal('http://explorer.internal:18080');
        });
    });
});
