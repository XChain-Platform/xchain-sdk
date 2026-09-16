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

const CONFIRMED = { txid: 'a'.repeat(64), vout: 0, value: 600,     scriptPubKey: '76a914aa88ac', confirmations: 12 };
const MEMPOOL   = { txid: 'b'.repeat(64), vout: 1, value: 5000000, scriptPubKey: '76a914aa88ac', confirmations: 0 };

// A tracker whose view the test can change between submits, counting fetches.
function trackerSdk(views) {
    let calls = 0;
    let sdk = makeSdk({
        _requireEncoder: () => ({
            getUTXOs: async () => {
                let view = views[Math.min(calls, views.length - 1)];
                calls += 1;
                return { utxos: view.map(u => ({ ...u })) };
            }
        })
    });
    sdk._fetches = () => calls;
    return sdk;
}

/*
 *  The session-injected cache must not override encoderOpts.unconfirmed.
 *  Injecting `utxos` stops the encoder making its own mempool-inclusive
 *  fetch, so a snapshot taken before a zero-conf output exists denies an
 *  opt-in the caller believes it has made. Under a min-difficulty lockout
 *  nothing confirms for hours, so a wallet funded moments ago cannot spend at
 *  all while appearing to have opted in.
 */

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('unconfirmed policy vs the injected cache', function () {
        it('unconfirmed:true re-pulls so a zero-conf output the snapshot predates is offered', async function () {
            // View 1 is the snapshot the first submit caches; view 2 adds the
            // mempool funding that arrives afterwards.
            let sdk = trackerSdk([[CONFIRMED], [CONFIRMED, MEMPOOL]]);
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });
            submitStub.resolves({ txid: 'tx', status: 'broadcast', spentInputs: [] });

            await session.submit({ action: 'SEND', params: {} });
            await session.submit({ action: 'SEND', params: {} }, { unconfirmed: true });

            let [, encoderOpts] = submitStub.secondCall.args;
            let keys = encoderOpts.utxos.map(u => u.txid + ':' + u.vout);
            assert.ok(keys.includes(MEMPOOL.txid + ':' + MEMPOOL.vout),
                'an explicit unconfirmed:true must put the zero-conf output on offer');
            assert.strictEqual(encoderOpts.unconfirmed, true, 'the flag still reaches the encoder');
            assert.strictEqual(sdk._fetches(), 2, 'the opt-in forced a fresh tracker pull');
        });

        it('leaves the cached fast path alone when unconfirmed is not stated', async function () {
            let sdk = trackerSdk([[CONFIRMED], [CONFIRMED, MEMPOOL]]);
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });
            submitStub.resolves({ txid: 'tx', status: 'broadcast', spentInputs: [] });

            await session.submit({ action: 'SEND', params: {} });
            await session.submit({ action: 'SEND', params: {} });

            assert.strictEqual(sdk._fetches(), 1,
                'a caller that stated no policy must not pay a tracker round trip per submit');
        });
    });
});

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('unconfirmed policy vs the injected cache', function () {
        it('unconfirmed:false strips zero-conf entries out of the injected set', async function () {
            let sdk = trackerSdk([[CONFIRMED, MEMPOOL]]);
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });
            submitStub.resolves({ txid: 'tx', status: 'broadcast', spentInputs: [] });

            await session.submit({ action: 'SEND', params: {} }, { unconfirmed: false });

            let [, encoderOpts] = submitStub.firstCall.args;
            let keys = encoderOpts.utxos.map(u => u.txid + ':' + u.vout);
            assert.deepStrictEqual(keys, [CONFIRMED.txid + ':' + CONFIRMED.vout]);
        });

        it('unconfirmed:false names the real cause when only chained change is available', async function () {
            // Mid-chain: the session's own speculative change is the only funding
            // it has, and every such entry is confirmations:0. The encoder would
            // filter them all and report "no utxos found on the blockchain",
            // pointing the operator at an address that is in fact funded.
            let sdk = trackerSdk([[CONFIRMED]]);
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });
            submitStub.onCall(0).resolves({
                txid: 'tx1', status: 'broadcast',
                spentInputs:   [{ txid: CONFIRMED.txid, vout: CONFIRMED.vout }],
                changeOutputs: [{ txid: 'c'.repeat(64), vout: 1, value: 400, scriptPubKey: '76a914aa88ac', confirmations: 0 }]
            });

            await session.submit({ action: 'SEND', params: {} });
            await assert.rejects(
                session.submit({ action: 'SEND', params: {} }, { unconfirmed: false }),
                err => err.code === 'NO_CONFIRMED_UTXOS' && /every available UTXO/.test(err.message)
            );
        });
    });
});

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('unconfirmed policy vs the injected cache', function () {
        it('a failed unconfirmed:false submit does not wedge the queue', async function () {
            let sdk = trackerSdk([[CONFIRMED]]);
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });
            submitStub.onCall(0).resolves({
                txid: 'tx1', status: 'broadcast',
                spentInputs:   [{ txid: CONFIRMED.txid, vout: CONFIRMED.vout }],
                changeOutputs: [{ txid: 'c'.repeat(64), vout: 1, value: 400, scriptPubKey: '76a914aa88ac', confirmations: 0 }]
            });
            submitStub.onCall(1).resolves({ txid: 'tx2', status: 'broadcast', spentInputs: [] });

            await session.submit({ action: 'SEND', params: {} });
            await assert.rejects(session.submit({ action: 'SEND', params: {} }, { unconfirmed: false }));
            let ok = await session.submit({ action: 'SEND', params: {} });
            assert.strictEqual(ok.txid, 'tx2');
        });

        it('an explicit unconfirmed:true still defers to caller-supplied utxos', async function () {
            let sdk = trackerSdk([[CONFIRMED, MEMPOOL]]);
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });
            submitStub.resolves({ txid: 'tx', status: 'broadcast', spentInputs: [] });

            let picked = [{ txid: 'd'.repeat(64), vout: 3, value: 1000, scriptPubKey: '76a914aa88ac', confirmations: 0 }];
            await session.submit({ action: 'SEND', params: {} }, { unconfirmed: true, utxos: picked });

            let [, encoderOpts] = submitStub.firstCall.args;
            assert.deepStrictEqual(encoderOpts.utxos, picked);
            assert.strictEqual(sdk._fetches(), 0, 'a hand-picked input list needs no tracker pull');
        });
    });
});
