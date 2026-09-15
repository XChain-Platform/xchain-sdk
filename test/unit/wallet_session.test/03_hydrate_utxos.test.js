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

const TRACKED = { txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '76a914aa88ac', confirmations: 4 };

function trackerSdk(view) {
    return makeSdk({
        _requireEncoder: () => ({ getUTXOs: async () => ({ utxos: view.map(u => ({ ...u })) }) })
    });
}

/*
 *  The compounding trap: the encoder REQUIRES scriptPubKey on every
 *  explicitly supplied utxo, and the public UTXO surfaces callers pick
 *  inputs from do not return it, so "select the inputs yourself" - the way
 *  around any selection the session makes - fails on a shape the caller
 *  cannot source.
 */

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('hydrateUTXOs', function () {
        it('fills scriptPubKey in from the tracker view', async function () {
            let session = new WalletSession(trackerSdk([TRACKED]), WIF_MAINNET);
            let out = await session.hydrateUTXOs([{ txid: TRACKED.txid, vout: 0 }]);
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].scriptPubKey, TRACKED.scriptPubKey);
            assert.strictEqual(out[0].value, TRACKED.value);
            assert.strictEqual(out[0].confirmations, 4);
        });

        it('hydrated entries go straight into submit', async function () {
            let session = new WalletSession(trackerSdk([TRACKED]), WIF_MAINNET, { waitForIndexer: false });
            submitStub.resolves({ txid: 'tx', status: 'broadcast', spentInputs: [] });
            let picked = await session.hydrateUTXOs([{ txid: TRACKED.txid, vout: 0 }]);
            await session.submit({ action: 'SEND', params: {} }, { utxos: picked });
            let [, encoderOpts] = submitStub.firstCall.args;
            assert.strictEqual(encoderOpts.utxos[0].scriptPubKey, TRACKED.scriptPubKey);
        });

        it('caller-supplied fields win over the tracker view', async function () {
            let session = new WalletSession(trackerSdk([TRACKED]), WIF_MAINNET);
            let out = await session.hydrateUTXOs([{ txid: TRACKED.txid, vout: 0, scriptPubKey: 'deadbeef' }]);
            assert.strictEqual(out[0].scriptPubKey, 'deadbeef');
        });
    });
});

describe('WalletSession', function () {
    beforeEach(function () {
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('hydrateUTXOs', function () {
        it('names the outpoints it cannot complete instead of failing at the encoder', async function () {
            let session = new WalletSession(trackerSdk([TRACKED]), WIF_MAINNET);
            await assert.rejects(
                session.hydrateUTXOs([{ txid: 'e'.repeat(64), vout: 7 }]),
                err => err.code === 'UTXO_NOT_FOUND' && err.message.includes('e'.repeat(64) + ':7')
            );
        });

        it('rejects a non-array and an entry with no outpoint', async function () {
            let session = new WalletSession(trackerSdk([TRACKED]), WIF_MAINNET);
            await assert.rejects(session.hydrateUTXOs('nope'), err => err.code === 'INVALID_UTXOS');
            await assert.rejects(session.hydrateUTXOs([{ vout: 0 }]), err => err.code === 'INVALID_UTXOS');
        });

        it('returns an empty list without touching the tracker', async function () {
            let called = false;
            let sdk = makeSdk({
                _requireEncoder: () => ({ getUTXOs: async () => { called = true; return { utxos: [] }; } })
            });
            let session = new WalletSession(sdk, WIF_MAINNET);
            assert.deepStrictEqual(await session.hydrateUTXOs([]), []);
            assert.strictEqual(called, false);
        });
    });
});
