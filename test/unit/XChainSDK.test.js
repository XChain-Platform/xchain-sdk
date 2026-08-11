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
const XChainSDK = require('../../src/XChainSDK.js');
const { SDKConfigError } = require('../../src/errors.js');

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

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
// back to the funding script. estimateFees now runs the same fail-closed reconcile gate
// submitAction does (), so a placeholder string is no longer a usable stand-in.
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

        // The forwarding list used to be hand-copied here and had fallen behind
        // createTx: feeQuote, compress, options and sourceAddress were dropped
        // silently, so a high-level caller lost its protocol-fee output, its FILE
        // compression policy, its Taproot signer capability and its source-address
        // UTXO selection with no error to tell it so.
        it('forwards EVERY optional encoder field to encoder.createTx', async function () {
            const EncoderClient = require('../../src/encoder.js');
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            const encoderOpts = { pubkey: 'mypubkey' };
            // A distinguishable value per optional field, whatever the list holds today.
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS) encoderOpts[key] = 'set:' + key;
            await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' },
                encoder: encoderOpts
            });
            const sent = sdk.encoder.createTx.firstCall.args[0];
            for (const key of EncoderClient.CREATE_TX_OPTION_FIELDS)
                expect(sent[key], key + ' must reach createTx').to.equal('set:' + key);
            expect(sent.pubkey).to.equal('mypubkey');
            expect(sent.data).to.be.a('string');
        });

        it('omits optional encoder fields the caller did not set (absent is not false)', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: 'aabbcc', encoding: 'OP_RETURN' });
            await sdk.createAction({
                action: 'SEND',
                params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' },
                encoder: { pubkey: 'mypubkey' }
            });
            const sent = sdk.encoder.createTx.firstCall.args[0];
            // createTx reads absent and explicit-false as different wire meanings
            // (compress is tri-state), so an unset field must not appear at all.
            expect(Object.prototype.hasOwnProperty.call(sent, 'compress')).to.equal(false);
            expect(Object.prototype.hasOwnProperty.call(sent, 'feeQuote')).to.equal(false);
        });

        // Drift guard: the shared list is the ONLY place the optional set is named,
        // so it has to stay equal to what createTx's own mapper actually reads.
        it('the shared option list covers every optional field createTx maps', function () {
            const fs = require('fs');
            const path = require('path');
            const EncoderClient = require('../../src/encoder.js');
            const src = fs.readFileSync(path.join(__dirname, '../../src/encoder.js'), 'utf8');
            const start = src.indexOf('async createTx(params)');
            // Stop at the next method, or spendP2sh's own params leak into the scan.
            const end = src.indexOf('\n    async ', start + 1);
            const body = src.slice(start, end);
            const read = new Set();
            for (const m of body.matchAll(/params\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
            read.delete('data'); read.delete('pubkey');   // required, set explicitly by each caller
            const listed = new Set(EncoderClient.CREATE_TX_OPTION_FIELDS);
            const missing = [...read].filter(k => !listed.has(k));
            expect(missing, 'createTx reads these but the shared list drops them: ' + missing.join(', ')).to.deep.equal([]);
        });
    });

    describe('deploy pre-flight: constructor-params warning', function () {
        const SRC_WITH_INIT = 'module.exports = { initialize: function (a) { xchain.state.set("owner", a); }, run: function () { return "1"; } };';
        const SRC_NO_INIT   = 'module.exports = { run: function () { return "1"; } };';
        const CTOR_RE = /exports initialize\(\) but no CONSTRUCTOR_PARAMS/;

        function warned(spy, re) {
            return spy.getCalls().some(c => re.test(String(c.args[0])));
        }

        afterEach(function () { sinon.restore(); });

        it('getExportedMethodNames returns the exported callable surface, [] on unparseable', function () {
            const c = makeSDK().contracts;
            expect(c.getExportedMethodNames(SRC_WITH_INIT).sort()).to.deep.equal(['initialize', 'run']);
            expect(c.getExportedMethodNames(SRC_NO_INIT)).to.deep.equal(['run']);
            expect(c.getExportedMethodNames('function ( {')).to.deep.equal([]);
        });

        it('warns when the contract exports initialize() but no CONSTRUCTOR_PARAMS are provided', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.true;
        });

        it('does not warn when CONSTRUCTOR_PARAMS are provided (UPPER or camelCase)', function () {
            const sdk = makeSDK();
            let spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, CONSTRUCTOR_PARAMS: ['0xabc'] }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.false;
            spy.restore();
            spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, constructorParams: ['0xabc'] }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.false;
        });

        it('treats an empty CONSTRUCTOR_PARAMS value ("" or []) as absent and still warns', function () {
            const sdk = makeSDK();
            let spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, CONSTRUCTOR_PARAMS: '' }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.true;
            spy.restore();
            spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT, CONSTRUCTOR_PARAMS: [] }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.true;
        });

        it('does not warn when the contract has no initialize export', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_NO_INIT }, 'warn');
            expect(warned(spy, CTOR_RE)).to.be.false;
        });

        it('skips the warning entirely when lint is off', function () {
            const sdk = makeSDK();
            const spy = sinon.stub(console, 'warn');
            sdk._preflightContractLint({ CODE: SRC_WITH_INIT }, 'off');
            expect(spy.called).to.be.false;
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
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub' }
            );
            expect(sdk.encoder.estimateFee.calledOnce).to.be.true;
            expect(result.actionString).to.be.a('string');
        });

        // . estimateFees hands back a PSBT the SDK docs say can be signed and
        // broadcast directly, so it has to clear the same fail-closed intent gate
        // submitAction applies. Before this it was the one signing route with none.
        it('estimateFees REFUSES an encoder answer that diverts value to a destination nobody asked for', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const ECPair = ECPairFactory(ecc);
            const mine = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const theirs = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const psbt = new bitcoin.Psbt({ network: net });
            psbt.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: mine, value: 100000 } });
            psbt.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            psbt.addOutput({ script: theirs, value: 99000 });        // the drain

            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: psbt.toHex(), encoding: 'OP_RETURN', fee: 1000 });
            let err = null;
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub' }
                );
            } catch (e) { err = e; }
            expect(err, 'estimateFees must fail closed on an unaccountable output').to.be.ok;
            expect(err.code).to.equal('UNRECONCILED_OUTPUT');
        });

        // , second half. The envelope reveal reaches estimateFees so the commit's
        // funding leg can be pinned to what actually spends it, but it is a GATE INPUT: the
        // gate above never reconciles it, so returning it would hand back a second signable
        // PSBT nothing checked - the same hole one field over.
        it('estimateFees consumes an envelope reveal as the phase pin and never returns it', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const ECPair = ECPairFactory(ecc);
            const script = () => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const mine = script();
            const leg  = bitcoin.script.compile([bitcoin.opcodes.OP_1, Buffer.from('bb'.repeat(32), 'hex')]);

            const commit = new bitcoin.Psbt({ network: net });
            commit.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: mine, value: 100000 } });
            commit.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            commit.addOutput({ script: leg, value: 50000 });
            commit.addOutput({ script: mine, value: 49000 });

            // A reveal that pays a stranger. The commit reconciles either way, so this is
            // only safe because the reveal does not leave the method.
            const reveal = new bitcoin.Psbt({ network: net });
            reveal.addInput({ hash: 'cc'.repeat(32), index: 0, witnessUtxo: { script: leg, value: 50000 } });
            reveal.addOutput({ script: script(), value: 49000 });

            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: commit.toHex(), encoding: 'TAPROOT', revealPsbt: reveal.toHex(), fee: 1000 });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub' }
            );
            expect(result.psbt, 'the gated commit is still returned').to.equal(commit.toHex());
            expect(result.revealPsbt, 'an ungated reveal must never reach the caller').to.equal(undefined);
        });

        // The pin the reveal exists for: a shaped leg the companion transaction does not
        // spend is value parked in a script only the encoder controls.
        it('estimateFees REFUSES an envelope commit whose funding leg the reveal never spends', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { ECPairFactory } = require('ecpair');
            bitcoin.initEccLib(ecc);
            const net = bitcoin.networks.regtest;
            const ECPair = ECPairFactory(ecc);
            const mine = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(ECPair.makeRandom({ network: net }).publicKey), network: net }).output;
            const leg  = bitcoin.script.compile([bitcoin.opcodes.OP_1, Buffer.from('bb'.repeat(32), 'hex')]);

            const commit = new bitcoin.Psbt({ network: net });
            commit.addInput({ hash: 'aa'.repeat(32), index: 0, witnessUtxo: { script: mine, value: 100000 } });
            commit.addOutput({ script: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('58434841494e', 'hex')]), value: 0 });
            commit.addOutput({ script: leg, value: 50000 });      // parked
            commit.addOutput({ script: mine, value: 49000 });

            const reveal = new bitcoin.Psbt({ network: net });
            reveal.addInput({ hash: 'cc'.repeat(32), index: 0, witnessUtxo: { script: leg, value: 1000 } });
            reveal.addOutput({ script: mine, value: 800 });

            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: commit.toHex(), encoding: 'TAPROOT', revealPsbt: reveal.toHex(), fee: 1000 });
            let err = null;
            try {
                await sdk.estimateFees(
                    { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                    { pubkey: 'mypub' }
                );
            } catch (e) { err = e; }
            expect(err, 'a parked funding leg must fail closed').to.be.ok;
            expect(err.code).to.equal('PHASE_FUNDING_UNSPENT');
        });

        it('estimateFees with payFeeInNativeCoin calls quoteNativeFee', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
            mockExplorer(sdk, { supported: true, valid: true, requiredFeeSats: 5000, feeDestination: 'feeaddr', actionString: 'SEND|...' });
            const result = await sdk.estimateFees(
                { action: 'SEND', params: { tick: 'TOKEN', amount: '100', destination: 'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC2W' } },
                { pubkey: 'mypub', payFeeInNativeCoin: true, source: 'addr1' }
            );
            expect(result.nativeFeeQuote).to.be.ok;
        });

        it('estimateFees throws when native fee unsupported', async function () {
            const sdk = makeSDK();
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
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
            mockEncoder(sdk, { psbt: estimatePsbtHex(), encoding: 'OP_RETURN', fee: 1000 });
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
    // Explorer query re-exports 
    // -----------------------------------------------------------------------

    describe('explorer query re-exports', function () {

        // Query/type-shaped explorer readers re-exported at the SDK top level
        const queryMethods = [
            'getMempool', 'getOrderCancels', 'getSwapCancels', 'getDispenserCancels',
            'getOrderMatches', 'getOrderEdits', 'getOrderExpires',
            'getSwapEdits', 'getSwapExpires',
            'getDispenserCloses', 'getDispenserEdits', 'getDispenserExpires'
        ];

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

        // : explorer.js carried all four BET reads while the SDK top level
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
            { m: 'getExecutions',         args: [42, 'contract', {}] },
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

        // : the `statuses` key in this assertion pinned the BUG. The SDK
        // forwarded a filter no explorer channel honors (getActionsSince selects
        // `NULL as status`), so a caller believed it had a filtered stream and did
        // not. The supported filters are asserted here; the dropped one below.
        it('onAction registers handler and subscribes with params when given', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { types: ['SEND'], ticks: ['TOKEN'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ types: ['SEND'] });
            unsub();
        });

        it('onAction does not forward the unsupported statuses or ticks filters', function () {
            // #3860: ticks joins statuses as a filter no action frame can honor -
            // getActionsSince selects no tick column, so it never narrows anything.
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { types: ['SEND'], statuses: ['valid'], ticks: ['TOKEN'] });
            const params = sdk.ws.subscribe.firstCall.args[1];
            expect(params).to.not.have.property('statuses');
            expect(params).to.not.have.property('ticks');
            expect(params).to.deep.equal({ types: ['SEND'] });
            unsub();
        });

        it('#3860: onAction with only a ticks filter subscribes with no params at all', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { ticks: ['TOKEN'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.equal(undefined);
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
            const unsub = sdk.onOrderMatch('addr1', cb);
            const params = sdk.ws.subscribe.firstCall.args[1];
            expect(params.address).to.equal('addr1');
            expect(params.types).to.deep.equal(['ORDER_MATCH']);
            unsub();
        });

        // : this assertion previously pinned the BUG. It asserted that a
        // caller-supplied `statuses` was forwarded, but no explorer channel ever
        // populates a per-event status (getActionsSince selects `NULL as status`),
        // so the filter could never reject anything and the caller silently got an
        // unfiltered stream. The SDK no longer forwards it; the server likewise
        // omits it from WELCOME features and SUBSCRIBED active_filters.
        it('onOrderMatch does not forward the unsupported statuses filter', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onOrderMatch('addr1', cb, { statuses: ['pending'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.not.have.property('statuses');
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
    // _applyEndpoints: creates clients when they don't exist
    // -----------------------------------------------------------------------

    describe('_applyEndpoints', function () {

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
    // start(): polling loop that stops when stopFlag is set
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
    // _isDowngrade: warns only once per service
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
            // Call _applyEndpoints again; second warning should be suppressed
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
            ['price', 'PRICE'],
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
