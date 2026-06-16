// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');

// We require WalletSession directly; it requires LifecycleManager internally.
// We mock LifecycleManager via module-level proxyquire-style or by stubbing
// the prototype. Since the repo doesn't use proxyquire, we stub the class
// prototype after requiring both modules.
const LifecycleManager = require('../../src/lifecycleManager.js');
const WalletSession = require('../../src/walletSession.js');

// Fake WIF key — bitcoinjs/ecpair accepts mainnet WIF
const WIF_MAINNET = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73NUBBy7N';

// Minimal wallet stub that mimics sdk.wallet
const fakeKeyInfo = {
    publicKeyHex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    publicKey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
    compressed: true
};

function makeSdk(overrides = {}) {
    let encoder = {
        getUTXOs: async (address) => ({ utxos: [{ txid: 'utxo1', vout: 0, value: 100000 }] })
    };
    return {
        wallet: {
            importWIF:     () => fakeKeyInfo,
            deriveAddress: () => 'mTestAddr123'
        },
        _requireEncoder: () => encoder,
        getBalances:    async (addr, opts) => [{ tick: 'TOK', quantity: '100' }],
        getHistory:     async (addr, type, opts) => [{ action: 'SEND' }],
        getCredits:     async (addr, type, opts) => [{ credit: 1 }],
        getDebits:      async (addr, type, opts) => [{ debit: 1 }],
        getSends:       async (addr, type, opts) => [{ send: 1 }],
        getOrders:      async (addr, type, opts) => [{ order: 1 }],
        getSwaps:       async (addr, type, opts) => [{ swap: 1 }],
        getDispensers:  async (addr, type, opts) => [{ dispenser: 1 }],
        estimateFees:   async (actionData, enc) => ({ fee: 1000 }),
        ...overrides
    };
}

describe('WalletSession', function () {

    let submitStub;

    beforeEach(function () {
        // Stub LifecycleManager.prototype.submitAction so submit() doesn't hit
        // the real encoder / network
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });

    afterEach(function () {
        sinon.restore();
    });

    /*
     *  Constructor
     */

    describe('constructor', function () {
        it('derives pubkey and address from wif', function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            assert.strictEqual(session.pubkey, fakeKeyInfo.publicKeyHex);
            assert.strictEqual(session.address, 'mTestAddr123');
            assert.strictEqual(session.compressed, true);
        });

        it('stores the wif', function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            assert.strictEqual(session.wif, WIF_MAINNET);
        });

        it('sets default submit options', function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            assert.strictEqual(session._defaultOpts.waitForIndexer, true);
            assert.strictEqual(session._defaultOpts.timeout, 120000);
            assert.strictEqual(session._defaultOpts.pollInterval, 2000);
            assert.strictEqual(session._defaultOpts.requireValid, true);
        });

        it('respects waitForIndexer=false option', function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET, { waitForIndexer: false });
            assert.strictEqual(session._defaultOpts.waitForIndexer, false);
        });

        it('respects custom timeout and pollInterval', function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET, { timeout: 60000, pollInterval: 1000 });
            assert.strictEqual(session._defaultOpts.timeout, 60000);
            assert.strictEqual(session._defaultOpts.pollInterval, 1000);
        });

        it('throws SDKWalletError when wif is missing', function () {
            try {
                new WalletSession(makeSdk());
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKWalletError');
                assert.strictEqual(e.code, 'INVALID_WIF');
            }
        });

        it('throws SDKWalletError when wif is null', function () {
            try {
                new WalletSession(makeSdk(), null);
                assert.fail('should have thrown');
            } catch (e) {
                assert.strictEqual(e.name, 'SDKWalletError');
            }
        });
    });

    /*
     *  refreshUTXOs()
     */

    describe('refreshUTXOs()', function () {
        it('loads UTXOs into the cache', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            let utxos = await session.refreshUTXOs();
            assert.strictEqual(utxos.length, 1);
            assert.strictEqual(utxos[0].txid, 'utxo1');
            assert.strictEqual(session._utxoCache.isLoaded(), true);
        });
    });

    /*
     *  submit()
     */

    describe('submit()', function () {
        it('calls LifecycleManager.submitAction with merged opts', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            let result = await session.submit({ action: 'SEND', params: { tick: 'TOKEN' } });
            assert.ok(submitStub.calledOnce);
            let [actionData, encoderOpts, submitOpts] = submitStub.firstCall.args;
            assert.strictEqual(actionData.action, 'SEND');
            // pubkey carries the sender ADDRESS (the encoder base58-decodes it
            // on the P2SH/P2WSH path; a hex pubkey breaks past OP_RETURN size)
            assert.strictEqual(encoderOpts.pubkey, 'mTestAddr123');
            assert.strictEqual(encoderOpts.change, 'mTestAddr123');
            assert.strictEqual(submitOpts.wif, WIF_MAINNET);
        });

        it('lazy-loads UTXOs when cache is empty', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            assert.strictEqual(session._utxoCache.isLoaded(), false);
            await session.submit({ action: 'SEND', params: {} });
            // After submit, cache should be loaded
            assert.strictEqual(session._utxoCache.isLoaded(), true);
        });

        it('does NOT refresh when caller provides explicit utxos', async function () {
            let getUTXOsCalled = false;
            let sdk = makeSdk({
                _requireEncoder: () => ({
                    getUTXOs: async () => { getUTXOsCalled = true; return { utxos: [] }; }
                })
            });
            let session = new WalletSession(sdk, WIF_MAINNET);
            await session.submit({ action: 'SEND', params: {} }, { utxos: [{ txid: 'provided', vout: 0 }] });
            assert.strictEqual(getUTXOsCalled, false);
        });

        it('marks spent inputs after submit', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            await session.refreshUTXOs();
            assert.strictEqual(session._utxoCache.getAvailable().length, 1);

            await session.submit({ action: 'SEND', params: {} });
            // utxo1:0 was marked spent by spentInputs in the stub result
            assert.strictEqual(session._utxoCache.getAvailable().length, 0);
        });

        it('re-refreshes a drained cache so two-step workflows keep funding', async function () {
            // First refresh returns the funding UTXO; after the first submit
            // spends it the cache is empty, and the second submit must
            // re-pull (returning the confirmed change) rather than fall
            // through to the encoder's pubkey-keyed fetch — a hex pubkey
            // resolves to no UTXOs there (setRoster / attachContent leg 2).
            let calls = 0;
            let sdk = makeSdk({
                _requireEncoder: () => ({
                    getUTXOs: async () => {
                        calls += 1;
                        return { utxos: calls === 1
                            ? [{ txid: 'utxo1', vout: 0, value: 100000 }]
                            : [{ txid: 'change1', vout: 1, value: 90000 }] };
                    }
                })
            });
            let session = new WalletSession(sdk, WIF_MAINNET);

            await session.submit({ action: 'LIST', params: {} });
            // spentInputs in the stub result consumed utxo1
            assert.strictEqual(session._utxoCache.getAvailable().length, 0);

            await session.submit({ action: 'LINK', params: {} });
            assert.strictEqual(calls, 2, 'second submit re-pulled UTXOs');
            let [, encoderOpts] = submitStub.secondCall.args;
            assert.ok(Array.isArray(encoderOpts.utxos), 'second submit funded from the cache');
            assert.strictEqual(encoderOpts.utxos[0].txid, 'change1');
        });

        it('merges submitOpts overrides', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            await session.submit({ action: 'SEND', params: {} }, {}, { timeout: 30000 });
            let [, , submitOpts] = submitStub.firstCall.args;
            assert.strictEqual(submitOpts.timeout, 30000);
        });

        it('merges encoderOpts overrides', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            await session.submit({ action: 'SEND', params: {} }, { fee: 2000 });
            let [, encoderOpts] = submitStub.firstCall.args;
            assert.strictEqual(encoderOpts.fee, 2000);
            // pubkey (sender address) and change still included
            assert.strictEqual(encoderOpts.pubkey, 'mTestAddr123');
        });

        it('returns lifecycle result', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            let result = await session.submit({ action: 'SEND', params: {} });
            assert.strictEqual(result.txid, 'faketx1');
        });
    });

    /*
     *  Action convenience methods
     */

    describe('action convenience methods', function () {
        let session;
        beforeEach(function () {
            session = new WalletSession(makeSdk(), WIF_MAINNET);
        });

        const actions = [
            ['send',     'SEND'],
            ['issue',    'ISSUE'],
            ['mint',     'MINT'],
            ['destroy',  'DESTROY'],
            ['transfer', 'SEND'],    // transfer maps to SEND
            ['order',    'ORDER'],
            ['swap',     'SWAP'],
            ['coinpay',  'COINPAY'],
            ['dispenser','DISPENSER'],
            ['dividend', 'DIVIDEND'],
            ['airdrop',  'AIRDROP'],
            ['sweep',    'SWEEP'],
            ['broadcast','BROADCAST'],
            ['message',  'MESSAGE'],
            ['file',     'FILE'],
            ['list',     'LIST'],
            ['link',     'LINK'],
            ['callback', 'CALLBACK'],
            ['sleep',    'SLEEP'],
            // 'address' method is shadowed by the this.address property set in constructor
            ['stake',    'STAKE'],
            ['unstake',  'UNSTAKE'],
            ['delegate', 'DELEGATE'],
            ['collect',  'COLLECT'],
            ['deploy',   'DEPLOY'],
            ['execute',  'EXECUTE'],
            ['deposit',  'DEPOSIT'],
            ['withdraw', 'WITHDRAW'],
        ];

        for (let [method, expectedAction] of actions) {
            it(method + '() calls submit with action=' + expectedAction, async function () {
                await session[method]({ tick: 'T' });
                let [actionData] = submitStub.lastCall.args;
                assert.strictEqual(actionData.action, expectedAction);
            });
        }

        it('stakeToContract() forces VERSION=3', async function () {
            await session.stakeToContract({ AMOUNT: '100', TICK: 'TOK' });
            let [actionData] = submitStub.lastCall.args;
            assert.strictEqual(actionData.action, 'STAKE');
            assert.strictEqual(actionData.params.VERSION, '3');
            assert.strictEqual(actionData.params.TICK, 'TOK');
        });

        it('unstakeFromContract() forces VERSION=1', async function () {
            await session.unstakeFromContract({ TICK: 'TOK' });
            let [actionData] = submitStub.lastCall.args;
            assert.strictEqual(actionData.action, 'UNSTAKE');
            assert.strictEqual(actionData.params.VERSION, '1');
        });

        it('delegateForContract() forces VERSION=1', async function () {
            await session.delegateForContract({ TICK: 'TOK' });
            let [actionData] = submitStub.lastCall.args;
            assert.strictEqual(actionData.action, 'DELEGATE');
            assert.strictEqual(actionData.params.VERSION, '1');
        });

        it('price() submits a PRICE action (v1 user oracle — only SDK-encodable version)', async function () {
            await session.price({ coin: 'BTC', tick: 'PEPECASH', fiat: 'USD', value: '1.50000000', fee: '0' });
            let [actionData] = submitStub.lastCall.args;
            assert.strictEqual(actionData.action, 'PRICE');
            assert.strictEqual(actionData.params.tick, 'PEPECASH');
        });
    });

    /*
     *  Explorer convenience methods
     */

    describe('explorer convenience methods', function () {
        let session;
        beforeEach(function () {
            session = new WalletSession(makeSdk(), WIF_MAINNET);
        });

        it('getBalances() calls sdk.getBalances with session address', async function () {
            let result = await session.getBalances();
            assert.ok(Array.isArray(result));
            assert.strictEqual(result[0].tick, 'TOK');
        });

        it('getHistory() calls sdk.getHistory with address type', async function () {
            let result = await session.getHistory();
            assert.ok(Array.isArray(result));
        });

        it('getCredits() defaults type to address', async function () {
            let capturedType;
            let sdk = makeSdk({ getCredits: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getCredits();
            assert.strictEqual(capturedType, 'address');
        });

        it('getCredits() passes explicit type', async function () {
            let capturedType;
            let sdk = makeSdk({ getCredits: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getCredits('source');
            assert.strictEqual(capturedType, 'source');
        });

        it('getDebits() defaults type to address', async function () {
            let capturedType;
            let sdk = makeSdk({ getDebits: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getDebits();
            assert.strictEqual(capturedType, 'address');
        });

        it('getSends() uses source type', async function () {
            let capturedType;
            let sdk = makeSdk({ getSends: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getSends();
            assert.strictEqual(capturedType, 'source');
        });

        it('getOrders() uses address type', async function () {
            let capturedType;
            let sdk = makeSdk({ getOrders: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getOrders();
            assert.strictEqual(capturedType, 'address');
        });

        it('getSwaps() uses address type', async function () {
            let capturedType;
            let sdk = makeSdk({ getSwaps: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getSwaps();
            assert.strictEqual(capturedType, 'address');
        });

        it('getDispensers() uses address type', async function () {
            let capturedType;
            let sdk = makeSdk({ getDispensers: async (addr, type) => { capturedType = type; return []; } });
            let s = new WalletSession(sdk, WIF_MAINNET);
            await s.getDispensers();
            assert.strictEqual(capturedType, 'address');
        });
    });

    /*
     *  estimateFees()
     */

    describe('estimateFees()', function () {
        it('calls sdk.estimateFees with merged pubkey/change', async function () {
            let capturedEnc;
            let sdk = makeSdk({
                estimateFees: async (actionData, enc) => { capturedEnc = enc; return { fee: 5000 }; }
            });
            let session = new WalletSession(sdk, WIF_MAINNET);
            let result = await session.estimateFees({ action: 'SEND', params: {} });
            assert.strictEqual(result.fee, 5000);
            assert.strictEqual(capturedEnc.pubkey, 'mTestAddr123');
            assert.strictEqual(capturedEnc.change, 'mTestAddr123');
        });

        it('merges caller-provided encoderOpts', async function () {
            let capturedEnc;
            let sdk = makeSdk({
                estimateFees: async (actionData, enc) => { capturedEnc = enc; return { fee: 1000 }; }
            });
            let session = new WalletSession(sdk, WIF_MAINNET);
            await session.estimateFees({ action: 'SEND', params: {} }, { encoding: 'P2SH' });
            assert.strictEqual(capturedEnc.encoding, 'P2SH');
        });
    });

});
