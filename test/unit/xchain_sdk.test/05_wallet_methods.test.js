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

describe('XChainSDK', function () {
    registerEnvHooks();

    // Wallet convenience methods

    describe('wallet methods', function () {

        it('signPsbt delegates to wallet.signPsbt', function () {
            const sdk = makeSDK();
            // Use a real PSBT + WIF from wallet
            const kp = sdk.wallet.generateKeyPair();
            // We can't sign without a real PSBT but we can verify delegation
            const spy = sinon.stub(sdk.wallet, 'signPsbt').returns({ signedPsbt: 'x' });
            sdk.signPsbt('psbt', kp.wif);
            expect(spy.calledOnce).to.be.true;
        });

        it('decomposePsbt delegates to wallet.decomposePsbt', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.wallet, 'decomposePsbt').returns({});
            sdk.decomposePsbt('psbt');
            expect(spy.calledOnce).to.be.true;
        });

        it('txidOf delegates to wallet.txidOf', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.wallet, 'txidOf').returns('txid');
            sdk.txidOf('txhex');
            expect(spy.calledOnce).to.be.true;
        });

        it('broadcastTx delegates to wallet.broadcastTx', async function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.wallet, 'broadcastTx').resolves({ txid: 'abc' });
            await sdk.broadcastTx('txhex');
            expect(spy.calledOnce).to.be.true;
        });

        it('getUTXOs delegates to wallet.getUTXOs', async function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.wallet, 'getUTXOs').resolves({ utxos: [] });
            await sdk.getUTXOs('addr1');
            expect(spy.calledOnce).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('wallet methods', function () {

        it('validateAddress delegates to wallet.validateAddress', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.wallet, 'validateAddress').returns(true);
            sdk.validateAddress('addr1', 'bitcoin-regtest');
            expect(spy.calledOnce).to.be.true;
        });

        it('importWIF delegates to wallet.importWIF', function () {
            const sdk = makeSDK();
            const kp = sdk.wallet.generateKeyPair();
            const result = sdk.importWIF(kp.wif);
            expect(result.wif).to.equal(kp.wif);
        });

        it('generateKeyPair delegates to wallet.generateKeyPair', function () {
            const sdk = makeSDK();
            const result = sdk.generateKeyPair();
            expect(result).to.have.property('wif');
        });

        it('deriveAddress delegates to wallet.deriveAddress', function () {
            const sdk = makeSDK();
            const kp = sdk.wallet.generateKeyPair();
            const result = sdk.deriveAddress(kp.publicKey);
            expect(result).to.be.a('string');
        });

        it('deriveMultisigAddress delegates to wallet.deriveMultisigAddress', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.wallet, 'deriveMultisigAddress').returns('msig');
            sdk.deriveMultisigAddress({ m: 2, pubkeys: [] });
            expect(spy.calledOnce).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // Auth convenience methods

    describe('auth methods', function () {

        it('generateChallenge delegates to auth', function () {
            const sdk = makeSDK();
            const result = sdk.generateChallenge('addr1', {});
            expect(result).to.be.ok;
        });

        it('signMessage delegates to auth', function () {
            const sdk = makeSDK();
            const kp = sdk.wallet.generateKeyPair();
            const challenge = sdk.generateChallenge(kp.wif, {});
            const spy = sinon.stub(sdk.auth, 'signMessage').returns({ signature: 'sig' });
            sdk.signMessage('message', kp.wif, {});
            expect(spy.calledOnce).to.be.true;
        });

        it('verifyOwnership delegates to auth', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.auth, 'verifyOwnership').returns(true);
            sdk.verifyOwnership('addr', 'msg', 'sig', 'bitcoin-regtest');
            expect(spy.calledOnce).to.be.true;
        });

        it('verifyMessage delegates to auth', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(sdk.auth, 'verifyMessage').returns(true);
            sdk.verifyMessage('addr', 'msg', 'sig', 'bitcoin-regtest');
            expect(spy.calledOnce).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    // Messaging convenience methods

    describe('messaging methods', function () {

        it('sendMessage delegates to messaging.send', async function () {
            const sdk = makeSDK();
            sinon.stub(sdk.messaging, 'send').resolves({ actionString: 'MESSAGE|...' });
            await sdk.sendMessage({ to: 'addr1', message: 'hello' });
            expect(sdk.messaging.send.calledOnce).to.be.true;
        });

        it('getPublicKey delegates to messaging.getPublicKey', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk);
            sinon.stub(sdk.messaging, 'getPublicKey').resolves('02abc');
            const result = await sdk.getPublicKey('addr1');
            expect(sdk.messaging.getPublicKey.calledOnce).to.be.true;
        });

        it('getMessagesForAddress delegates to messaging.getMessages', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk);
            sinon.stub(sdk.messaging, 'getMessages').resolves([]);
            await sdk.getMessagesForAddress('addr1', {});
            expect(sdk.messaging.getMessages.calledOnce).to.be.true;
        });

        it('getGatedFileRaw delegates to explorer.getGatedFileRaw', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk, Buffer.from([0x01]));
            await sdk.getGatedFileRaw(42);
            expect(sdk.explorer.getGatedFileRaw.calledOnce).to.be.true;
        });

        it('getAllMessagesForAddress throws without network configured', async function () {
            const sdk = new XChainSDK({ explorerUrl: 'http://localhost:8080' });
            // explorer is null without network
            if (!sdk.explorer) sdk.explorer = { baseUrl: 'http://localhost', port: 8080, timeout: 30000, retry: false, hooks: {} };
            try {
                await sdk.getAllMessagesForAddress('addr1', {});
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('NETWORK_NOT_CONFIGURED');
            }
        });

        it('getAllMessagesForAddress creates per-chain explorers and calls messaging.getAllMessages', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk);
            sinon.stub(sdk.messaging, 'getAllMessages').resolves([]);
            await sdk.getAllMessagesForAddress('addr1', {});
            expect(sdk.messaging.getAllMessages.calledOnce).to.be.true;
        });
    });
});
