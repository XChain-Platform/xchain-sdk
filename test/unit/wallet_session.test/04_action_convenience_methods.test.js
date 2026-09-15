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

const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const WalletSession = require('../../../src/utils/wallet_session.js');

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
 *  Action convenience methods
 */

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('action convenience methods', function () {
        let session;
        beforeEach(function () {
            session = new WalletSession(makeSdk(), WIF_MAINNET);
        });

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

        it('price() submits a PRICE action (v1 user oracle, only SDK-encodable version)', async function () {
            await session.price({ coin: 'BTC', tick: 'PEPECASH', fiat: 'USD', value: '1.50000000', fee: '0' });
            let [actionData] = submitStub.lastCall.args;
            assert.strictEqual(actionData.action, 'PRICE');
            assert.strictEqual(actionData.params.tick, 'PEPECASH');
        });
    });
});
