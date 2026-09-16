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
 *  submit()
 */

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

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
    });
});

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('submit()', function () {
        it('serializes concurrent submits so they cannot reserve the same UTXO', async function () {
            // Two UTXOs available; each submit spends utxo1 (per the stub below).
            let sdk = makeSdk({
                _requireEncoder: () => ({
                    getUTXOs: async () => ({ utxos: [
                        { txid: 'utxo1', vout: 0, value: 100000 },
                        { txid: 'utxo2', vout: 0, value: 100000 }
                    ] })
                })
            });
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });

            // Capture the UTXO set each submit was handed, holding the FIRST submit
            // open inside submitAction until the test observes it there, then
            // releasing it. This keeps the async gap open deterministically (no
            // sleep): a non-serialized implementation would let the second submit
            // read UTXOs while the first is parked, and it would see utxo1 too.
            let seen = [];
            let firstEntered, releaseFirst;
            const firstIn   = new Promise(r => { firstEntered = r; });
            const firstGate = new Promise(r => { releaseFirst = r; });
            submitStub.callsFake(async (actionData, encoderOpts) => {
                seen.push((encoderOpts.utxos || []).map(u => u.txid + ':' + u.vout));
                if (seen.length === 1) { firstEntered(); await firstGate; }
                return { txid: 'tx', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] };
            });

            const all = Promise.all([
                session.submit({ action: 'SEND', params: {} }),
                session.submit({ action: 'SEND', params: {} })
            ]);
            await firstIn;      // first submit is parked inside submitAction, holding utxo1
            releaseFirst();     // let it finish; a serialized queue starts the second afterward
            await all;

            // The first submit saw utxo1 available. Because submits serialize, the
            // second ran only after the first marked utxo1 spent, so it must not
            // have been offered utxo1 again (the double-spend this guard prevents).
            assert.ok(seen[0].includes('utxo1:0'));
            assert.ok(!seen[1].includes('utxo1:0'), 'second submit must not reuse the spent utxo1');
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

    describe('submit()', function () {
        it('a failed submit does not wedge later submits in the queue', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET, { waitForIndexer: false });
            submitStub.onCall(0).rejects(new Error('broadcast failed'));
            submitStub.onCall(1).resolves({ txid: 'tx2', status: 'broadcast', spentInputs: [] });

            await assert.rejects(session.submit({ action: 'SEND', params: {} }), /broadcast failed/);
            // The queue must still run the next submit rather than stall behind the failure.
            let ok = await session.submit({ action: 'SEND', params: {} });
            assert.strictEqual(ok.txid, 'tx2');
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
    });
});

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('submit()', function () {
        // The chaining guarantee: addSpeculative hands the change back to the
        // cache, so the next submit spends it. Without that call every submit
        // drains the cache, the re-pull below hands the next submit whatever the
        // tracker has CONFIRMED, and two consecutive sends from one wallet
        // session pick independent inputs and land as siblings, not parent -> child.
        it('registers the change output so the next submit spends it (chain, not siblings)', async function () {
            let calls = 0;
            let sdk = makeSdk({
                _requireEncoder: () => ({
                    getUTXOs: async () => {
                        calls += 1;
                        return { utxos: [{ txid: 'utxo1', vout: 0, value: 100000, scriptPubKey: '76a914aa88ac' }] };
                    }
                })
            });
            let session = new WalletSession(sdk, WIF_MAINNET, { waitForIndexer: false });

            const change = { txid: 'tx1', vout: 1, value: 90000, scriptPubKey: '76a914aa88ac', confirmations: 0 };
            submitStub.onCall(0).resolves({
                txid: 'tx1', status: 'broadcast',
                spentInputs:   [{ txid: 'utxo1', vout: 0 }],
                changeOutputs: [change]
            });
            submitStub.onCall(1).resolves({ txid: 'tx2', status: 'broadcast', spentInputs: [{ txid: 'tx1', vout: 1 }], changeOutputs: [] });

            await session.submit({ action: 'SEND', params: {} });
            await session.submit({ action: 'SEND', params: {} });

            // The second submit funded from tx1's own change: that is the
            // parent-child chain. A re-pull would mean the cache was empty and
            // the tracker chose the inputs instead.
            let [, encoderOpts] = submitStub.secondCall.args;
            assert.deepStrictEqual(encoderOpts.utxos, [change]);
            assert.strictEqual(calls, 1, 'the change made a second tracker pull unnecessary');
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

    describe('submit()', function () {
        it('does not re-offer change that a later phase of the same submit already spent', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET, { waitForIndexer: false });
            // A two-phase action whose reveal consumed its own phase-1 change:
            // the lifecycle already filters it out of changeOutputs, and
            // markSpent runs first here so a stale entry could not survive either.
            submitStub.onCall(0).resolves({
                txid: 'p2', status: 'broadcast',
                spentInputs:   [{ txid: 'utxo1', vout: 0 }, { txid: 'p1', vout: 1 }],
                changeOutputs: [{ txid: 'p1', vout: 1, value: 90000, scriptPubKey: '76a914aa88ac', confirmations: 0 }]
            });

            await session.submit({ action: 'DEPLOY', params: {} });
            let keys = session._utxoCache.getAvailable().map(u => u.txid + ':' + u.vout);
            assert.ok(!keys.includes('p1:1'), 'a spent outpoint must never be offered as change');
        });

        it('tolerates a lifecycle result with no changeOutputs field', async function () {
            let session = new WalletSession(makeSdk(), WIF_MAINNET, { waitForIndexer: false });
            submitStub.onCall(0).resolves({ txid: 'tx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
            await session.submit({ action: 'SEND', params: {} });
            assert.strictEqual(session._utxoCache.getAvailable().length, 0);
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

    describe('submit()', function () {
        it('re-refreshes a drained cache so two-step workflows keep funding', async function () {
            // First refresh returns the funding UTXO; after the first submit
            // spends it the cache is empty, and the second submit must
            // re-pull (returning the confirmed change) rather than fall
            // through to the encoder's pubkey-keyed fetch (a hex pubkey
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
    });
});

describe('WalletSession', function () {
    let submitStub;
    beforeEach(function () {
        submitStub = sinon.stub(LifecycleManager.prototype, 'submitAction');
        submitStub.resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('submit()', function () {
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
});
