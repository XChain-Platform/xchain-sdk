// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

'use strict';

const assert  = require('assert');
const { expect } = require('chai');
const sinon   = require('sinon');
const XChainSDK = require('../../src/XChainSDK.js');
const { SDKConfigError } = require('../../src/errors.js');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

// Env vars the SDK reads — clear them so tests are deterministic
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

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe('XChainSDK', function () {

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

    // -----------------------------------------------------------------------
    // Constructor / init
    // -----------------------------------------------------------------------

    describe('constructor', function () {

        it('constructs with network only', function () {
            const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
            expect(sdk.actions).to.be.ok;
            expect(sdk.util).to.be.ok;
            expect(sdk.wallet).to.be.ok;
        });

        it('exposes version and name', function () {
            const sdk = makeSDK();
            // These come from npm_package_version — may be undefined in test env
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

    // -----------------------------------------------------------------------
    // init()
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // stop()
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // _requireExplorer / _requireEncoder / _requireWs
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // ACTION methods
    // -----------------------------------------------------------------------

    describe('createAction', function () {

        it('returns actionString for SEND without encoder', async function () {
            const sdk = makeSDK();
            const result = await sdk.createAction({ action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } });
            expect(result.actionString).to.be.a('string');
            expect(result.actionString).to.include('SEND');
        });

        it('calls encoder.createTx when encoder options with pubkey provided', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            const result = await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' },
                encoder: { pubkey: 'mypubkey' }
            });
            expect(result.psbt).to.equal('aabbcc');
            expect(result.encoding).to.equal('OP_RETURN');
            expect(sdk.encoder.createTx.calledOnce).to.be.true;
        });
    });

    describe('submitAction', function () {

        it('creates a LifecycleManager and delegates', async function () {
            const sdk = makeSDK();
            // Stub LifecycleManager
            const LifecycleManager = require('../../src/lifecycleManager.js');
            const submitStub = sinon.stub().resolves({ txid: 'fake' });
            sinon.stub(LifecycleManager.prototype, 'submitAction').callsFake(submitStub);
            const result = await sdk.submitAction({ action: 'SEND', params: {} }, { pubkey: 'pub' }, {});
            expect(submitStub.calledOnce).to.be.true;
        });
    });

    describe('validateAction', function () {
        it('delegates to actions.validateAction', function () {
            const sdk = makeSDK();
            const result = sdk.validateAction('SEND', { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' });
            expect(result).to.be.an('object');
        });
    });

    describe('getActions / getActionFormats / getActionFields', function () {
        it('getActions returns list of supported actions', function () {
            const sdk = makeSDK();
            const result = sdk.getActions();
            expect(result).to.be.an('array');
            expect(result.length).to.be.greaterThan(0);
        });

        it('getActionFormats returns formats for SEND', function () {
            const sdk = makeSDK();
            const result = sdk.getActionFormats('SEND');
            expect(result).to.be.ok;
        });

        it('getActionFields returns fields for SEND', function () {
            const sdk = makeSDK();
            const result = sdk.getActionFields('SEND');
            expect(result).to.be.ok;
        });
    });

    // -----------------------------------------------------------------------
    // Convenience action methods (all delegate to createAction)
    // -----------------------------------------------------------------------

    describe('convenience action methods', function () {
        const methods = [
            ['send', 'SEND'], ['issue', 'ISSUE'], ['mint', 'MINT'],
            ['destroy', 'DESTROY'], ['order', 'ORDER'], ['transfer', 'SEND'],
            ['broadcast', 'BROADCAST'], ['dispenser', 'DISPENSER'],
            ['dividend', 'DIVIDEND'], ['sweep', 'SWEEP'], ['swap', 'SWAP'],
            ['callback', 'CALLBACK'], ['coinpay', 'COINPAY'], ['sleep', 'SLEEP'],
            ['airdrop', 'AIRDROP'], ['message', 'MESSAGE'], ['list', 'LIST'],
            ['link', 'LINK'], ['file', 'FILE'], ['address', 'ADDRESS'],
            ['stake', 'STAKE'], ['unstake', 'UNSTAKE'], ['delegate', 'DELEGATE'],
            ['collect', 'COLLECT'], ['deploy', 'DEPLOY'], ['execute', 'EXECUTE'],
            ['deposit', 'DEPOSIT'], ['withdraw', 'WITHDRAW']
        ];

        for (const [method, action] of methods) {
            it(method + '() calls createAction with action=' + action, async function () {
                const sdk = makeSDK();
                const spy = sinon.stub(sdk, 'createAction').resolves({ actionString: action + '|...' });
                await sdk[method]({}, undefined);
                expect(spy.calledOnce).to.be.true;
                expect(spy.firstCall.args[0].action).to.equal(action);
            });
        }
    });

    // -----------------------------------------------------------------------
    // contract() / session() / batch()
    // -----------------------------------------------------------------------

    describe('contract()', function () {
        it('returns a ContractClient instance', function () {
            const sdk = makeSDK();
            const ContractClient = require('../../src/contractClient.js');
            const cc = sdk.contract(42);
            expect(cc).to.be.instanceOf(ContractClient);
        });
    });

    describe('controller (programmable policy)', function () {
        it('exposes sdk.controller as a ControllerHelpers instance', function () {
            const sdk = makeSDK();
            const ControllerHelpers = require('../../src/controller.js');
            expect(sdk.controller).to.be.instanceOf(ControllerHelpers);
        });
        it('getContractManifest delegates to the explorer reader', async function () {
            const sdk = makeSDK();
            sinon.stub(sdk.explorer, 'getContractManifest').resolves({ permissions: ['SEND'], maxTakeBps: 250 });
            const m = await sdk.getContractManifest(42);
            expect(m).to.deep.equal({ permissions: ['SEND'], maxTakeBps: 250 });
            expect(sdk.explorer.getContractManifest.calledWith(42)).to.equal(true);
        });
    });

    describe('session()', function () {
        it('returns a WalletSession instance', function () {
            const sdk = makeSDK();
            const WalletSession = require('../../src/walletSession.js');
            // Use a valid WIF for regtest
            const kp = sdk.wallet.generateKeyPair();
            const session = sdk.session(kp.wif, {});
            expect(session).to.be.instanceOf(WalletSession);
        });
    });

    describe('batch()', function () {
        it('returns a BatchBuilder', function () {
            const sdk = makeSDK();
            const BatchBuilder = require('../../src/batchBuilder.js');
            const b = sdk.batch();
            expect(b).to.be.instanceOf(BatchBuilder);
        });
    });

    // -----------------------------------------------------------------------
    // Workflow methods
    // -----------------------------------------------------------------------

    describe('workflow methods', function () {
        const workflowMethods = [
            'issueAndDistribute', 'issueAndMint', 'createDispenser',
            'createOrder', 'cancelOrder', 'stakeAndDelegate',
            'deployAndFund', 'distributeDividend'
        ];

        for (const method of workflowMethods) {
            it(method + '() delegates to workflows.' + method, async function () {
                const sdk = makeSDK();
                sinon.stub(sdk.workflows, method).resolves({ success: true });
                const result = await sdk[method]('wif', {}, {});
                expect(sdk.workflows[method].calledOnce).to.be.true;
            });
        }
    });

    // -----------------------------------------------------------------------
    // Encoder methods
    // -----------------------------------------------------------------------

    describe('encoder methods', function () {

        it('encodeTx delegates to encoder.createTx', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'OP_RETURN' });
            const result = await sdk.encodeTx({ data: 'TEST', pubkey: 'pub' });
            expect(sdk.encoder.createTx.calledOnce).to.be.true;
        });

        it('spendP2sh delegates to encoder.spendP2sh', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'P2SH' });
            await sdk.spendP2sh({ pubkey: 'pub', p2shHash: 'h', p2shHex: 'x' });
            expect(sdk.encoder.spendP2sh.calledOnce).to.be.true;
        });

        it('pingEncoder delegates to encoder.ping', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { status: 'ok' });
            await sdk.pingEncoder();
            expect(sdk.encoder.ping.calledOnce).to.be.true;
        });

        it('estimateFees builds actionString and calls encoder.estimateFee', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'OP_RETURN', fee: 1000 });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub' }
            );
            expect(sdk.encoder.estimateFee.calledOnce).to.be.true;
            expect(result.actionString).to.be.a('string');
        });

        it('estimateFees with payFeeInNativeCoin calls quoteNativeFee', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: true, valid: true, requiredFeeSats: 5000, feeDestination: 'feeaddr', actionString: 'SEND|...' });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub', payFeeInNativeCoin: true, source: 'addr1' }
            );
            expect(result.nativeFeeQuote).to.be.ok;
        });

        it('estimateFees throws when native fee unsupported', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: false, valid: false, error: 'unsupported' });
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub', payFeeInNativeCoin: true }
                );
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('NATIVE_FEE_UNSUPPORTED');
            }
        });

        it('estimateFees throws when native fee invalid', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'xx', encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: true, valid: false, error: 'stale price' });
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub', payFeeInNativeCoin: true }
                );
                expect.fail('should throw');
            } catch (e) {
                expect(e.code).to.equal('NATIVE_FEE_INVALID');
            }
        });
    });

    // -----------------------------------------------------------------------
    // quoteNativeFee
    // -----------------------------------------------------------------------

    describe('quoteNativeFee', function () {

        it('calls explorer.getFeeQuote with parsed action parts', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk, { supported: true, valid: true, requiredFeeSats: 1000 });
            const result = await sdk.quoteNativeFee(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { source: 'addr1' }
            );
            expect(sdk.explorer.getFeeQuote.calledOnce).to.be.true;
            expect(result.actionString).to.be.a('string');
        });
    });

    // -----------------------------------------------------------------------
    // getFeeSchedule
    // -----------------------------------------------------------------------

    describe('getFeeSchedule', function () {

        it('delegates to explorer.getFeeSchedule', async function () {
            const sdk = makeSDK();
            mockExplorer(sdk, { actions: [] });
            await sdk.getFeeSchedule();
            expect(sdk.explorer.getFeeSchedule.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    // Hub methods
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Wallet convenience methods
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Auth convenience methods
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Messaging convenience methods
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Explorer passthrough methods
    // -----------------------------------------------------------------------

    describe('explorer passthrough methods', function () {
        // All these methods just call _requireExplorer().<method>(args)
        const explorerMethods = [
            { m: 'getBalances',           args: ['addr1', {}] },
            { m: 'getAddress',            args: ['addr1'] },
            { m: 'getHolders',            args: ['TOKEN', {}] },
            { m: 'getCredits',            args: ['addr1', 'address', {}] },
            { m: 'getDebits',             args: ['addr1', 'address', {}] },
            { m: 'getEscrows',            args: ['addr1', 'address', {}] },
            { m: 'getToken',              args: ['TOKEN'] },
            { m: 'getTokens',             args: ['addr1', 'address', {}] },
            { m: 'getIssues',             args: ['TOKEN', 'token', {}] },
            { m: 'getTransaction',        args: ['abc', 'tx_hash'] },
            { m: 'getAction',             args: [42] },
            { m: 'getBlock',              args: [100] },
            { m: 'getHistory',            args: ['addr1', 'address', {}] },
            { m: 'getAddresses',          args: ['addr1', 'address', {}] },
            { m: 'getAirdrops',           args: ['addr1', 'address', {}] },
            { m: 'getBatches',            args: ['addr1', 'address', {}] },
            { m: 'getBroadcasts',         args: ['addr1', 'address', {}] },
            { m: 'getCallbacks',          args: ['addr1', 'address', {}] },
            { m: 'getDestroys',           args: ['addr1', 'address', {}] },
            { m: 'getCoinpays',           args: ['addr1', 'address', {}] },
            { m: 'getCoinpayExpires',     args: ['addr1', 'address', {}] },
            { m: 'getCoinpayObligations', args: ['addr1', 'address', {}] },
            { m: 'getDispensers',         args: ['addr1', 'address', {}] },
            { m: 'getDispenses',          args: ['addr1', 'address', {}] },
            { m: 'getDividends',          args: ['addr1', 'address', {}] },
            { m: 'getFees',               args: ['addr1', 'address', {}] },
            { m: 'getFiles',              args: ['addr1', 'address', {}] },
            { m: 'getLinks',              args: ['addr1', 'address', {}] },
            { m: 'getLists',              args: ['addr1', 'address', {}] },
            { m: 'getMessages',           args: ['addr1', 'address', {}] },
            { m: 'getMints',              args: ['addr1', 'address', {}] },
            { m: 'getOrders',             args: ['addr1', 'address', {}] },
            { m: 'getSends',              args: ['addr1', 'address', {}] },
            { m: 'getSleeps',             args: ['addr1', 'address', {}] },
            { m: 'getSwaps',              args: ['addr1', 'address', {}] },
            { m: 'getSwapMatches',        args: ['100', 'block', {}] },
            { m: 'getSweeps',             args: ['addr1', 'address', {}] },
            { m: 'getContract',           args: [42] },
            { m: 'getContracts',          args: ['addr1', 'address', {}] },
            { m: 'getContractState',      args: [42, 'key'] },
            { m: 'getContractBalance',    args: [42, 'TOKEN'] },
            { m: 'getAttestations',       args: ['addr1', 'address', {}] },
            { m: 'getExecution',          args: [99] },
            { m: 'getExecutions',         args: [42, {}] },
            { m: 'getDeposits',           args: ['addr1', 'address', {}] },
            { m: 'getWithdrawals',        args: ['addr1', 'address', {}] },
            { m: 'getStakes',             args: ['addr1', 'address', {}] },
            { m: 'getDelegations',        args: ['addr1', 'address', {}] },
            { m: 'getValidators',         args: [{}] },
            { m: 'getValidatorRewards',   args: ['addr1', 'address', {}] },
            { m: 'getMarkets',            args: ['TOKEN'] },
            { m: 'getMarket',             args: ['A', 'B'] },
            { m: 'getMarketHistory',      args: ['A', 'B', 'addr1', {}] },
            { m: 'getMarketOrders',       args: ['A', 'B', 'addr1', {}] },
            { m: 'getOrderbook',          args: ['A', 'B'] },
            { m: 'getStatus',             args: [] },
            { m: 'search',                args: ['q', 'token'] },
        ];

        let sdk;
        beforeEach(function () {
            sdk = makeSDK();
            mockExplorer(sdk, { total: 0, data: [] });
        });

        for (const { m, args } of explorerMethods) {
            it(m + '() delegates to explorer.' + m, async function () {
                await sdk[m](...args);
                expect(sdk.explorer[m].calledOnce).to.be.true;
            });
        }
    });

    // -----------------------------------------------------------------------
    // WebSocket convenience methods
    // -----------------------------------------------------------------------

    describe('WebSocket methods', function () {

        let sdk;

        function makeSDKWithWs() {
            const s = makeSDK();
            s.ws = {
                connect:      sinon.stub().resolves({}),
                disconnect:   sinon.stub(),
                on:           sinon.stub(),
                off:          sinon.stub(),
                subscribe:    sinon.stub().resolves({ type: 'SUBSCRIBED', data: { channel: 'blocks' } }),
                unsubscribe:  sinon.stub()
            };
            return s;
        }

        it('connectWs delegates to ws.connect', async function () {
            sdk = makeSDKWithWs();
            await sdk.connectWs();
            expect(sdk.ws.connect.calledOnce).to.be.true;
        });

        it('disconnectWs delegates to ws.disconnect', function () {
            sdk = makeSDKWithWs();
            sdk.disconnectWs();
            expect(sdk.ws.disconnect.calledOnce).to.be.true;
        });

        it('disconnectWs is a no-op when ws is null', function () {
            sdk = makeSDK();
            sdk.ws = null;
            expect(() => sdk.disconnectWs()).to.not.throw();
        });

        it('onBlock registers handler and subscribes to blocks channel', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onBlock(cb);
            expect(sdk.ws.on.calledWith('NEW_BLOCK', cb)).to.be.true;
            expect(sdk.ws.subscribe.called).to.be.true;
            expect(typeof unsub).to.equal('function');
            unsub();
            expect(sdk.ws.off.calledWith('NEW_BLOCK', cb)).to.be.true;
        });

        it('onAction registers handler and subscribes with params when given', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { types: ['SEND'], statuses: ['valid'], ticks: ['TOKEN'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ types: ['SEND'], statuses: ['valid'], ticks: ['TOKEN'] });
            unsub();
        });

        it('onAction subscribes without params when opts empty', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            sdk.onAction(cb);
            // params should be undefined (empty object has no keys)
            expect(sdk.ws.subscribe.firstCall.args[1]).to.equal(undefined);
        });

        it('onAddress registers multiple handlers and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAddress('addr1', cb, { snapshot: true });
            expect(sdk.ws.subscribe.firstCall.args[0]).to.deep.equal(['address']);
            expect(sdk.ws.subscribe.firstCall.args[1].address).to.equal('addr1');
            expect(sdk.ws.subscribe.firstCall.args[1].snapshot).to.be.true;
            unsub();
        });

        it('onToken registers handler and subscribes with tick+snapshot', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onToken('TOKEN', cb);
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ tick: 'TOKEN', snapshot: true });
            unsub();
        });

        it('onMarket registers handler and subscribes with tick1/tick2', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onMarket('A', 'B', cb);
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ tick1: 'A', tick2: 'B', snapshot: true });
            unsub();
        });

        it('onDispenser registers multiple handlers and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onDispenser(42, cb);
            expect(sdk.ws.subscribe.firstCall.args[1].action_index).to.equal(42);
            unsub();
        });

        it('onCoinpayRequired registers handler and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onCoinpayRequired('addr1', cb);
            expect(sdk.ws.subscribe.firstCall.args[1].address).to.equal('addr1');
            unsub();
        });

        it('onOrderMatch registers handler and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onOrderMatch('addr1', cb, { statuses: ['pending'] });
            expect(sdk.ws.subscribe.firstCall.args[1].statuses).to.deep.equal(['pending']);
            unsub();
        });

        it('onNetworkStats registers handler and subscribes to network', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onNetworkStats(cb);
            expect(sdk.ws.subscribe.firstCall.args[0]).to.deep.equal(['network']);
            unsub();
        });

        it('waitForAction creates ActionWaiter and calls waitForTxid', async function () {
            sdk = makeSDK();
            const ActionWaiter = require('../../src/actionWaiter.js');
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ action_index: 42 });
            const result = await sdk.waitForAction('txid1', { timeout: 5000 });
            expect(result.action_index).to.equal(42);
        });

        it('waitForActionIndex creates ActionWaiter and calls waitForActionIndex', async function () {
            sdk = makeSDK();
            const ActionWaiter = require('../../src/actionWaiter.js');
            sinon.stub(ActionWaiter.prototype, 'waitForActionIndex').resolves({ action_index: 99 });
            const result = await sdk.waitForActionIndex(99, {});
            expect(result.action_index).to.equal(99);
        });
    });

    // -----------------------------------------------------------------------
    // _applyEndpoints — creates clients when they don't exist
    // -----------------------------------------------------------------------

    describe('_applyEndpoints', function () {

        it('creates explorer client from hub endpoints when explorer is null', async function () {
            // Use a network that has no explorer URL without a hub so explorer starts null,
            // then hub supplies one — triggers line 240 "else if (network)" create branch
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
            sdk._applyEndpoints();
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
            sdk._applyEndpoints();
            expect(setBaseSpy.calledOnce).to.be.true;
        });

        it('creates encoder client from hub endpoints when encoder is null', async function () {
            const sdk = new XChainSDK({
                network: 'bitcoin-regtest',
                hubUrl: 'http://localhost:8001'
            });
            sdk.hub.getAllConfig = sinon.stub().resolves({});
            sdk.hub.extractServiceEndpoints = sinon.stub().returns({
                encoderUrl: 'http://encoder.test',
                encoderPort: 3000
            });
            sdk.hub.startPolling = sinon.stub();
            await sdk._ensureReady();
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
            sdk._applyEndpoints();
            expect(setBaseSpy.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    // start() — polling loop that stops when stopFlag is set
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // _isDowngrade — warns only once per service
    // -----------------------------------------------------------------------

    describe('_isDowngrade', function () {

        it('logs warn only once per service even if called multiple times', async function () {
            const sdk = new XChainSDK({ network: 'bitcoin-mainnet' });
            sdk.hub.getAllConfig = sinon.stub().resolves({});
            sdk.hub.extractServiceEndpoints = sinon.stub().returns({
                explorerUrl: 'http://insecure.internal',
                explorerPort: 18080
            });
            sdk.hub.startPolling = sinon.stub();
            const warnSpy = sinon.stub(console, 'warn');
            await sdk._ensureReady();
            // Call _applyEndpoints again — second warning should be suppressed
            sdk._discovering = null;  // reset to allow re-apply
            sdk._applyEndpoints();
            // warn should have been called at most once for 'explorer'
            const explorerWarns = warnSpy.args.filter(a => String(a[0]).includes('explorer'));
            expect(explorerWarns.length).to.equal(1);
        });
    });

    // ─── Action-shortcut methods → createAction({ action, params, encoder }) ──
    describe('action shortcut methods', function () {
        const SHORTCUTS = [
            ['send', 'SEND'], ['issue', 'ISSUE'], ['mint', 'MINT'], ['destroy', 'DESTROY'],
            ['order', 'ORDER'], ['transfer', 'SEND'], ['broadcast', 'BROADCAST'],
            ['dispenser', 'DISPENSER'], ['dividend', 'DIVIDEND'], ['sweep', 'SWEEP'],
            ['swap', 'SWAP'], ['callback', 'CALLBACK'], ['coinpay', 'COINPAY'], ['sleep', 'SLEEP'],
            ['airdrop', 'AIRDROP'], ['message', 'MESSAGE'], ['list', 'LIST'], ['link', 'LINK'],
            ['file', 'FILE'], ['address', 'ADDRESS'], ['stake', 'STAKE'], ['unstake', 'UNSTAKE'],
            ['delegate', 'DELEGATE'], ['collect', 'COLLECT'], ['deploy', 'DEPLOY'],
            ['execute', 'EXECUTE'], ['deposit', 'DEPOSIT'], ['withdraw', 'WITHDRAW'],
        ];

        let sdk, createStub;
        beforeEach(function () {
            sdk = makeSDK();
            // Stub the underlying action builder so no encoding/network is needed.
            createStub = sinon.stub(sdk.actions, 'createAction').returns({ actionString: 'OK' });
        });
        afterEach(function () { sinon.restore(); });

        for (const [method, action] of SHORTCUTS) {
            it(`sdk.${method}() builds a ${action} action`, async function () {
                const params = { k: 'v' };
                const result = await sdk[method](params);
                expect(createStub.calledOnce).to.equal(true);
                const arg = createStub.firstCall.args[0];
                expect(arg.action).to.equal(action);
                expect(arg.params).to.deep.equal(params);
                expect(result).to.deep.equal({ actionString: 'OK' });
            });
        }

        it('passes the encoder option through to createAction', async function () {
            const enc = { pubkey: undefined, fee: 10 };
            await sdk.send({ k: 'v' }, enc);
            expect(createStub.firstCall.args[0].encoder).to.equal(enc);
        });
    });

});
