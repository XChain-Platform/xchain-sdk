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
const LifecycleManager = require('../../src/lifecycleManager.js');
const WalletSession = require('../../src/walletSession.js');

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
            releaseFirst();     // let it finish; a serialized queue only now starts the second
            await all;

            // The first submit saw utxo1 available. Because submits serialize, the
            // second ran only after the first marked utxo1 spent, so it must not
            // have been offered utxo1 again (the double-spend this guard prevents).
            assert.ok(seen[0].includes('utxo1:0'));
            assert.ok(!seen[1].includes('utxo1:0'), 'second submit must not reuse the spent utxo1');
        });

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
     *  The session-injected cache must not override encoderOpts.unconfirmed.
     *  Injecting `utxos` stops the encoder making its own mempool-inclusive
     *  fetch, so a snapshot taken before a zero-conf output exists denies an
     *  opt-in the caller believes it has made. Under a min-difficulty lockout
     *  nothing confirms for hours, so a lane funded moments ago cannot spend at
     *  all while appearing to have opted in.
     */

    describe('unconfirmed policy vs the injected cache', function () {

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

    /*
     *  The compounding trap: the encoder REQUIRES scriptPubKey on every
     *  explicitly supplied utxo, and the public UTXO surfaces callers pick
     *  inputs from do not return it, so "select the inputs yourself" - the way
     *  around any selection the session makes - fails on a shape the caller
     *  cannot source.
     */

    describe('hydrateUTXOs', function () {

        const TRACKED = { txid: 'a'.repeat(64), vout: 0, value: 100000, scriptPubKey: '76a914aa88ac', confirmations: 4 };

        function trackerSdk(view) {
            return makeSdk({
                _requireEncoder: () => ({ getUTXOs: async () => ({ utxos: view.map(u => ({ ...u })) }) })
            });
        }

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

        it('price() submits a PRICE action (v1 user oracle, only SDK-encodable version)', async function () {
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
