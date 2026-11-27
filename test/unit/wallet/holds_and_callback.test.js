// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');

const WalletUtils = require('../../../src/utils/wallet.js');
const { XChainSDK } = require('../../..');
const { createMemoryCallbackStore } = require('../../../src/utils/wallet/callback_store.js');

const NETWORK = 'bitcoin-mainnet';
const APP_ID = 'test.example';
const ORIGIN = 'https://test.example';
const WIF = 'KyrSGCFPhqZMjCe5fNTYddiLMp4tMj4gLKuJ26TsB2rvr1VJGPbt';
const REQUEST_ID = 'A'.repeat(22);
const CLAIM = 'B'.repeat(22);

function authUtils() {
    return new XChainSDK({ network: NETWORK }).auth;
}

function signedLogin(auth, nonce, { appId = APP_ID, origin = ORIGIN } = {}) {
    const probe = auth.signMessage('address probe', WIF);
    const timestamp = Date.now() - 100;
    const expiresAt = Date.now() + 60_000;
    const challenge = [
        'XChain Sign-In v2', appId, origin, probe.address, nonce, timestamp, expiresAt,
    ].join(' / ');
    const signed = auth.signMessage(challenge, WIF);
    const entry = {
        address: signed.address,
        chainId: NETWORK,
        challenge,
        challengeParts: {
            version: 2,
            appId,
            origin,
            address: signed.address,
            nonce,
            timestamp,
            expiresAt,
        },
        signature: signed.signature,
        signatureFormat: 'legacy',
    };
    return Object.assign({ ok: true, addresses: [entry], challengeParts: entry.challengeParts }, entry);
}

function callback(result, claim) {
    const body = { v: 1, id: REQUEST_ID, method: 'login', ok: true, result };
    if (claim !== undefined) body.claim = claim;
    return body;
}

describe('AuthUtils.holdsAtLeast()', function () {
    it('is exposed on sdk.auth through the production wallet entry', function () {
        const auth = authUtils();
        assert.strictEqual(typeof auth.holdsAtLeast, 'function');
        assert.strictEqual(typeof auth.receiveCallback, 'function');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(
            WalletUtils.prototype, 'holdsAtLeast'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(
            WalletUtils.prototype, 'receiveCallback'), false);
        assert.strictEqual(typeof Object.getPrototypeOf(auth).holdsAtLeast, 'function');
        assert.strictEqual(typeof Object.getPrototypeOf(auth).receiveCallback, 'function');
        assert.deepStrictEqual(Object.keys(Object.getPrototypeOf(auth)), []);
    });

    it('reads the selected chain and compares exact decimal amounts', async function () {
        const calls = [];
        const auth = authUtils();
        const explorer = {
            async getBalances(address) {
                calls.push(address);
                return { data: [{ tick: 'ACCESS', amount: '0.99999999999999999999' }] };
            },
        };

        const result = await auth.holdsAtLeast('proven-address', 'ACCESS', '1', {
            chainId: NETWORK,
            explorer,
        });

        assert.deepStrictEqual(calls, ['proven-address']);
        assert.strictEqual(result.holds, false);
        assert.strictEqual(result.amount.eq('0.99999999999999999999'), true);
        assert.strictEqual(result.amount.isBigNumber, true);
    });

    it('requires an explicit valid chain and a balances data array', async function () {
        const auth = authUtils();
        await assert.rejects(auth.holdsAtLeast('address', 'ACCESS', '1'), /chainId/);
        await assert.rejects(auth.holdsAtLeast('address', 'ACCESS', '1', {
            chainId: 'unknown-chain',
            explorer: { getBalances: async () => ({ data: [] }) },
        }));
        await assert.rejects(auth.holdsAtLeast('address', 'ACCESS', '1', {
            chainId: NETWORK,
            explorer: { getBalances: async () => ({ rows: [] }) },
        }), /data array/);
    });
});

function callbackSetup() {
    return {
        auth: authUtils(),
        store: createMemoryCallbackStore(),
    };
}

it('AuthUtils.receiveCallback() verifies before consuming or storing', async function () {
    const { auth, store } = callbackSetup();
    const nonce = store.issueNonce('same-device');
    const result = signedLogin(auth, nonce);
    const events = [];
    const orderedStore = {
        issueNonce: store.issueNonce.bind(store),
        get: store.get.bind(store),
        takeNonce(value) {
            events.push('take');
            return store.takeNonce(value);
        },
        put(id, record) {
            events.push('put');
            return store.put(id, record);
        },
    };
    const originalVerify = auth.verifyLogin.bind(auth);
    auth.verifyLogin = function (...args) {
        events.push('verify');
        return originalVerify(...args);
    };

    const received = await auth.receiveCallback(callback(result, CLAIM), {
        store: orderedStore,
        appId: APP_ID,
        origin: ORIGIN,
    });

    assert.deepStrictEqual(events, ['verify', 'take', 'put']);
    assert.strictEqual(received.accepted, true);
    assert.strictEqual(received.status, 'approved-unclaimed');
    assert.strictEqual(received.claimed, false);
    assert.strictEqual(received.verified.address, result.address);
    assert.strictEqual(store.get(REQUEST_ID).claimed, false);
    assert.strictEqual(store.get(REQUEST_ID).claim, CLAIM);
});

it('AuthUtils.receiveCallback() applies the claim rule for each nonce mode', async function () {
    const { auth, store } = callbackSetup();
    const crossNonce = store.issueNonce('cross-device');
    const accepted = await auth.receiveCallback(callback(signedLogin(auth, crossNonce)), {
        store,
        appId: APP_ID,
        origin: ORIGIN,
    });

    assert.strictEqual(accepted.status, 'approved');
    assert.strictEqual(accepted.claimed, true);
    assert.strictEqual(store.get(REQUEST_ID).claimed, true);

    const sameStore = createMemoryCallbackStore();
    const sameNonce = sameStore.issueNonce('same-device');
    const unclaimed = await auth.receiveCallback(callback(signedLogin(auth, sameNonce)), {
        store: sameStore,
        appId: APP_ID,
        origin: ORIGIN,
    });

    assert.strictEqual(unclaimed.status, 'approved-unclaimed');
    assert.strictEqual(unclaimed.claimed, false);
    assert.strictEqual(sameStore.get(REQUEST_ID).claimed, false);
    assert.strictEqual(sameStore.get(REQUEST_ID).claim, null);
});

it('AuthUtils.receiveCallback() preserves a nonce after failed verification', async function () {
    const { auth, store } = callbackSetup();
    const nonce = store.issueNonce('cross-device');
    const result = signedLogin(auth, nonce);
    result.signature = result.signature.slice(0, -1) + 'A';
    result.addresses[0].signature = result.signature;

    const received = await auth.receiveCallback(callback(result), {
        store,
        appId: APP_ID,
        origin: ORIGIN,
    });

    assert.strictEqual(received.accepted, false);
    assert.match(received.error, /signature/i);
    assert.strictEqual(store.get(REQUEST_ID), null);
    assert.deepStrictEqual(store.takeNonce(nonce), { mode: 'cross-device' });
});

it('AuthUtils.receiveCallback() rejects replay, bad bindings, and bad claims', async function () {
    const { auth, store } = callbackSetup();
    const nonce = store.issueNonce('same-device');
    const result = signedLogin(auth, nonce);
    const first = await auth.receiveCallback(callback(result, CLAIM), {
        store,
        appId: APP_ID,
        origin: ORIGIN,
    });
    assert.strictEqual(first.accepted, true);

    const replay = await auth.receiveCallback(callback(result, CLAIM), {
        store,
        appId: APP_ID,
        origin: ORIGIN,
    });
    assert.strictEqual(replay.accepted, false);
    assert.match(replay.error, /nonce/i);

    const otherStore = createMemoryCallbackStore();
    const otherNonce = otherStore.issueNonce('same-device');
    const wrongOrigin = await auth.receiveCallback(callback(signedLogin(auth, otherNonce)), {
        store: otherStore,
        appId: APP_ID,
        origin: 'https://wrong.example',
    });
    assert.strictEqual(wrongOrigin.accepted, false);
    assert.match(wrongOrigin.error, /origin/i);
    assert.strictEqual(otherStore.get(REQUEST_ID), null);

    const malformed = await auth.receiveCallback(callback(result, 'not-base64url'), { store });
    assert.strictEqual(malformed.accepted, false);
    assert.match(malformed.error, /claim/i);
});

it('AuthUtils.receiveCallback() requires receiver-pinned login bindings', async function () {
    const auth = authUtils();
    let verifyCalls = 0;
    const originalVerify = auth.verifyLogin.bind(auth);
    auth.verifyLogin = function (...args) {
        verifyCalls += 1;
        return originalVerify(...args);
    };
    const cases = [
        { options: {}, challenge: { appId: 'foreign-app', origin: 'foreign-origin' } },
        { options: {}, challenge: {} },
        { options: { appId: APP_ID }, challenge: {} },
        { options: { origin: ORIGIN }, challenge: {} },
        { options: { appId: APP_ID, origin: '' }, challenge: {} },
    ];

    for (const sample of cases) {
        const store = createMemoryCallbackStore();
        const nonce = store.issueNonce('cross-device');
        const result = signedLogin(auth, nonce, sample.challenge);
        const received = await auth.receiveCallback(callback(result),
            Object.assign({ store }, sample.options));
        assert.strictEqual(received.accepted, false);
        assert.match(received.error, /appId\/origin are required/);
        assert.strictEqual(store.get(REQUEST_ID), null);
        assert.deepStrictEqual(store.takeNonce(nonce), { mode: 'cross-device' });
    }
    assert.strictEqual(verifyCalls, 0);
});

it('AuthUtils.receiveCallback() stores other successes and wallet rejections', async function () {
    const { auth, store } = callbackSetup();
    const success = {
        v: 1,
        id: REQUEST_ID,
        method: 'signMessage',
        ok: true,
        result: { signature: 'signed' },
    };
    const received = await auth.receiveCallback(success, { store });
    assert.deepStrictEqual(received, { accepted: true, id: REQUEST_ID, status: 'received' });
    assert.strictEqual(store.get(REQUEST_ID).body, success);

    const rejectedStore = createMemoryCallbackStore();
    const rejection = {
        v: 1,
        id: REQUEST_ID,
        method: 'login',
        ok: false,
        error: 'USER_REJECTED',
    };
    const rejected = await auth.receiveCallback(rejection, { store: rejectedStore });
    assert.deepStrictEqual(rejected, { accepted: true, id: REQUEST_ID, status: 'rejected' });
    assert.strictEqual(rejectedStore.get(REQUEST_ID).body, rejection);
});
