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
const sinon = require('sinon');

// We require WalletSession directly; it requires LifecycleManager internally.
// We mock LifecycleManager via module-level proxyquire-style or by stubbing
// the prototype. Since the repo doesn't use proxyquire, we stub the class
// prototype after requiring both modules.
const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const WalletSession = require('../../../src/utils/wallet_session.js');

// Fake WIF key: bitcoinjs/ecpair accepts mainnet WIF
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

/*
 *  Constructor
 */

describe('WalletSession', function () {
    beforeEach(function () {
        // Stub LifecycleManager.prototype.submitAction so submit() doesn't hit
        // the real encoder / network
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('WalletSession', function () {
    beforeEach(function () {
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('constructor', function () {
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
});

/*
 *  refreshUTXOs()
 */

describe('WalletSession', function () {
    beforeEach(function () {
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('refreshUTXOs()', function () {
        it('loads UTXOs into the cache', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET);
            let utxos = await session.refreshUTXOs();
            assert.strictEqual(utxos.length, 1);
            assert.strictEqual(utxos[0].txid, 'utxo1');
            assert.strictEqual(session._utxoCache.isLoaded(), true);
        });
    });
});
