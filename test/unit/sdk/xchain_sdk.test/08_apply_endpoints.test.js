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
const XChainSDK = require('../../../../src/XChainSDK.js');

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

describe('XChainSDK', function () {
    registerEnvHooks();

    // applyEndpoints: creates clients when they don't exist

    describe('applyEndpoints', function () {

        it('creates explorer client from hub endpoints when explorer is null', async function () {
            // Use a network that has no explorer URL without a hub so explorer starts null,
            // then hub supplies one, triggering the "else if (network)" create branch
            const sdk = new XChainSDK({
                network: 'bitcoin-regtest',
                hubUrl: 'http://localhost:8001'
            });
            // Force explorer to null (normally regtest still creates it at localhost:8080)
            sdk.explorer = null;
            sdk.hub.getAllConfig = sinon.stub().resolves({});
            sdk.hub.extractServiceEndpoints = sinon.stub().returns({
                explorerUrl: 'http://explorer.test',
                explorerPort: 8080
            });
            sdk.hub.startPolling = sinon.stub();
            sdk.applyEndpoints();
            expect(sdk.explorer).to.be.ok;
        });

        it('updates existing explorer via setBase from hub endpoints', async function () {
            const sdk = makeSDK();
            const setBaseSpy = sinon.spy(sdk.explorer, 'setBase');
            sdk.hub = {
                getAllConfig: sinon.stub().resolves({}),
                extractServiceEndpoints: sinon.stub().returns({
                    explorerUrl: 'http://new-explorer.test',
                    explorerPort: 9090
                }),
                startPolling: sinon.stub()
            };
            // Use a minimal options object so options.explorerUrl is not set
            sdk.options = { network: 'bitcoin-regtest', retry: false };
            sdk.applyEndpoints();
            expect(setBaseSpy.calledOnce).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('applyEndpoints', function () {

        it('creates encoder client from hub endpoints when encoder is null', async function () {
            const sdk = new XChainSDK({
                network: 'bitcoin-regtest',
                hubUrl: 'http://localhost:8001'
            });
            // ensureReady() drives discover(), which calls hub.getDiscoveryConfig()
            // (the keyless/public path), not getAllConfig(); stub the method that
            // is actually on the call path.
            sdk.hub.getDiscoveryConfig = sinon.stub().resolves({});
            sdk.hub.extractServiceEndpoints = sinon.stub().returns({
                encoderUrl: 'http://encoder.test',
                encoderPort: 3000
            });
            sdk.hub.startPolling = sinon.stub();
            await sdk.ensureReady();
            expect(sdk.encoder).to.be.ok;
        });

        it('updates existing encoder via setBase from hub endpoints', async function () {
            const sdk = makeSDK();
            const setBaseSpy = sinon.spy(sdk.encoder, 'setBase');
            sdk.hub = {
                getAllConfig: sinon.stub().resolves({}),
                extractServiceEndpoints: sinon.stub().returns({
                    encoderUrl: 'http://new-encoder.test',
                    encoderPort: 4000
                }),
                startPolling: sinon.stub()
            };
            sdk.options = { network: 'bitcoin-regtest', retry: false };
            sdk.applyEndpoints();
            expect(setBaseSpy.calledOnce).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // start(): polling loop that stops when stopFlag is set

    describe('start()', function () {

        it('starts up and stops when stop() is called', async function () {
            const sdk = makeSDK();
            // Override sleep to call stop() after first iteration so loop exits fast
            sinon.stub(sdk.util, 'sleep').callsFake(async () => { sdk.stop(); });
            const logSpy = sinon.stub(console, 'log');
            await sdk.start();
            expect(logSpy.calledOnce).to.be.true;
            expect(sdk.stopFlag).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // isDowngrade: warns only once per service

    describe('isDowngrade', function () {

        it('logs warn only once per service even if called multiple times', async function () {
            const sdk = new XChainSDK({ network: 'bitcoin-mainnet' });
            // Stub the method ensureReady()'s discover() actually calls, so this
            // stays hermetic instead of quietly racing a real network fetch.
            sdk.hub.getDiscoveryConfig = sinon.stub().resolves({});
            sdk.hub.extractServiceEndpoints = sinon.stub().returns({
                explorerUrl: 'http://insecure.internal',
                explorerPort: 18080
            });
            sdk.hub.startPolling = sinon.stub();
            const warnSpy = sinon.stub(console, 'warn');
            await sdk.ensureReady();
            // Call applyEndpoints again; second warning should be suppressed
            sdk._discovering = null;  // reset to allow re-apply
            sdk.applyEndpoints();
            // warn should have been called at most once for 'explorer'
            const explorerWarns = warnSpy.args.filter(a => String(a[0]).includes('explorer'));
            expect(explorerWarns.length).to.equal(1);
        });
    });
});
