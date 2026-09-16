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

const assert  = require('assert');
const { expect } = require('chai');
const sinon   = require('sinon');
const XChainSDK = require('../../../src/XChainSDK.js');
const { SDKConfigError } = require('../../../src/utils/errors.js');

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

// Build a stub that resolves to `returnVal` for every call
function stub(returnVal) {
    return sinon.stub().resolves(returnVal);
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

// A REAL encoder-shaped answer: one unsigned input, a zero-value carrier, and change
// back to the funding script. estimateFees runs the same fail-closed reconcile gate
// submitAction does, so a placeholder string is no longer a usable stand-in.
function estimatePsbtHex() {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const { ECPairFactory } = require('ecpair');
    bitcoin.initEccLib(ecc);
    const net = bitcoin.networks.regtest;
    const kp = ECPairFactory(ecc).makeRandom({ network: net });
    const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: net }).output;
    const psbt = new bitcoin.Psbt({ network: net });
    psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script, value: 100000 } });
    psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
    psbt.addOutput({ script, value: 99000 });
    return psbt.toHex();
}

// Patch all encoder methods
function mockEncoder(sdk, returnVal = {}) {
    const encoder = sdk.encoder;
    const proto = Object.getPrototypeOf(encoder);
    const methods = Object.getOwnPropertyNames(proto)
        .filter(m => !m.startsWith('_') && m !== 'constructor');
    for (const m of methods) {
        if (typeof encoder[m] === 'function') {
            sinon.stub(encoder, m).resolves(returnVal);
        }
    }
    return encoder;
}

// Tests

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

    // Constructor / init

    describe('constructor', function () {

        it('constructs with network only', function () {
            const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
            expect(sdk.actions).to.be.ok;
            expect(sdk.util).to.be.ok;
            expect(sdk.wallet).to.be.ok;
        });

        it('exposes version and name', function () {
            const sdk = makeSDK();
            // These come from npm_package_version; may be undefined in test env
            expect(sdk).to.have.property('version');
            expect(sdk).to.have.property('name');
        });

        it('exposes config, util, actions, contracts, musig2', function () {
            const sdk = makeSDK();
            expect(sdk.config).to.be.ok;
            expect(sdk.util).to.be.ok;
            expect(sdk.actions).to.be.ok;
            expect(sdk.contracts).to.be.ok;
            expect(sdk.musig2).to.be.ok;
        });

        it('exposes wallet, auth, messaging, gatedFile, attestation', function () {
            const sdk = makeSDK();
            expect(sdk.wallet).to.be.ok;
            expect(sdk.auth).to.be.ok;
            expect(sdk.messaging).to.be.ok;
            expect(sdk.gatedFile).to.be.ok;
            expect(sdk.attestation).to.be.ok;
        });

        it('sets network from env when not in options', function () {
            process.env.NETWORK = 'bitcoin-regtest';
            const sdk = new XChainSDK({ explorerUrl: 'http://localhost:8080' });
            expect(sdk.explorer).to.be.ok;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // init()

    describe('init()', function () {

        it('is a no-op when hub not configured', async function () {
            const sdk = makeSDK();
            expect(sdk.hub).to.equal(null);
            await sdk.init(); // should not throw
        });

        it('calls _discover when hub is configured', async function () {
            const sdk = makeSDK();
            // Create a fake hub
            sdk.hub = {
                getAllConfig: sinon.stub().resolves({}),
                extractServiceEndpoints: sinon.stub().returns({}),
                startPolling: sinon.stub()
            };
            await sdk.init();
            expect(sdk.hub.getAllConfig.called).to.be.true;
        });

        it('warns but does not throw when hub fails and clients exist', async function () {
            const sdk = makeSDK();
            sdk.hub = {
                getAllConfig: sinon.stub().rejects(new Error('hub down')),
                extractServiceEndpoints: sinon.stub().returns({}),
                startPolling: sinon.stub()
            };
            const warnSpy = sinon.stub(console, 'warn');
            await sdk.init(); // should not throw
            expect(warnSpy.called).to.be.true;
        });

        it('throws when hub fails and no explorer/encoder clients exist', async function () {
            const sdk = new XChainSDK({
                network: 'bitcoin-mainnet',
                hubUrl:  'http://localhost:8001'
            });
            sdk.hub.getAllConfig = sinon.stub().rejects(new Error('hub down'));
            sdk.hub.extractServiceEndpoints = sinon.stub().returns({});
            sdk.hub.startPolling = sinon.stub();
            sdk.explorer = null;
            sdk.encoder = null;
            try {
                await sdk.init();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('hub down');
            }
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // stop()

    describe('stop()', function () {

        it('sets stopFlag and calls hub.stopPolling when hub configured', function () {
            const sdk = makeSDK();
            sdk.hub = { stopPolling: sinon.stub() };
            sdk.stop();
            expect(sdk.stopFlag).to.be.true;
            expect(sdk.hub.stopPolling.calledOnce).to.be.true;
        });

        it('disconnects ws when configured', function () {
            const sdk = makeSDK();
            sdk.ws = { disconnect: sinon.stub() };
            sdk.stop();
            expect(sdk.ws.disconnect.calledOnce).to.be.true;
        });

        it('is a no-op when no hub or ws', function () {
            const sdk = makeSDK();
            expect(sdk.hub).to.equal(null);
            expect(() => sdk.stop()).to.not.throw();
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // _requireExplorer / _requireEncoder / _requireWs

    describe('guards', function () {

        it('_requireExplorer throws EXPLORER_NOT_CONFIGURED when explorer is null', function () {
            const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
            // Regtest has no encoder so use a fresh SDK with no URL
            const plain = new XChainSDK({});
            plain.explorer = null;
            try {
                plain._requireExplorer();
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('EXPLORER_NOT_CONFIGURED');
            }
        });

        it('_requireEncoder throws ENCODER_NOT_CONFIGURED when encoder is null', function () {
            const sdk = new XChainSDK({});
            sdk.encoder = null;
            try {
                sdk._requireEncoder();
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('ENCODER_NOT_CONFIGURED');
            }
        });

        it('_requireWs throws WEBSOCKET_NOT_CONFIGURED when ws is null', function () {
            const sdk = makeSDK();
            sdk.ws = null;
            try {
                sdk._requireWs();
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('WEBSOCKET_NOT_CONFIGURED');
            }
        });
    });
});
