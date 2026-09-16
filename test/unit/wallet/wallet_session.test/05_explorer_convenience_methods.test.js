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

const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const WalletSession = require('../../../../src/utils/wallet_session.js');

const WIF_MAINNET = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73NUBBy7N';

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
 *  Explorer convenience methods
 */

describe('WalletSession', function () {
    beforeEach(function () {
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('WalletSession', function () {
    beforeEach(function () {
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('explorer convenience methods', function () {
        let session;
        beforeEach(function () {
            session = new WalletSession(makeSdk(), WIF_MAINNET);
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
});
