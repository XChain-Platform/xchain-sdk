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

const assert = require('assert');
const { createMemoryCallbackStore } = require('../../../src/utils/wallet/callback_store.js');

describe('memory callback store', function() {
    let clock;
    let store;

    beforeEach(function() {
        clock = 1000;
        store = createMemoryCallbackStore({
            now: () => clock,
            nonceTtlMs: 100,
            maxEntries: 2,
        });
    });

    it('issues fresh 128-bit unpadded base64url nonces for both modes', function() {
        const sameDevice = store.issueNonce('same-device');
        const crossDevice = store.issueNonce('cross-device');

        assert.match(sameDevice, /^[A-Za-z0-9_-]{22}$/);
        assert.match(crossDevice, /^[A-Za-z0-9_-]{22}$/);
        assert.notStrictEqual(sameDevice, crossDevice);
        assert.deepStrictEqual(store.takeNonce(sameDevice), { mode: 'same-device' });
        assert.deepStrictEqual(store.takeNonce(crossDevice), { mode: 'cross-device' });
    });

    it('rejects unsupported nonce modes', function() {
        for (const mode of ['', 'same_device', 'other', null, undefined]) {
            assert.throws(() => store.issueNonce(mode), /mode must be/);
        }
    });

    it('consumes a nonce once and returns null for reuse or an unknown nonce', function() {
        const nonce = store.issueNonce('same-device');

        assert.deepStrictEqual(store.takeNonce(nonce), { mode: 'same-device' });
        assert.strictEqual(store.takeNonce(nonce), null);
        assert.strictEqual(store.takeNonce('unknown'), null);
    });

    it('expires a nonce at the TTL boundary', function() {
        const nonce = store.issueNonce('cross-device');
        clock += 100;

        assert.strictEqual(store.takeNonce(nonce), null);
        assert.strictEqual(store.takeNonce(nonce), null);
    });

    it('stores and retrieves records until the same TTL expires', function() {
        const record = { ok: true, result: { address: 'address-1' } };
        store.put('request-1', record);

        assert.strictEqual(store.get('request-1'), record);
        clock += 99;
        assert.strictEqual(store.get('request-1'), record);
        clock += 1;
        assert.strictEqual(store.get('request-1'), null);
    });

    it('drops the oldest record when maxEntries is exceeded', function() {
        store.put('oldest', { order: 1 });
        clock += 1;
        store.put('middle', { order: 2 });
        clock += 1;
        store.put('newest', { order: 3 });

        assert.strictEqual(store.get('oldest'), null);
        assert.deepStrictEqual(store.get('middle'), { order: 2 });
        assert.deepStrictEqual(store.get('newest'), { order: 3 });
    });

    it('refreshes a replaced record before applying the capacity limit', function() {
        store.put('first', { version: 1 });
        clock += 1;
        store.put('second', { version: 1 });
        clock += 1;
        store.put('first', { version: 2 });
        clock += 1;
        store.put('third', { version: 1 });

        assert.deepStrictEqual(store.get('first'), { version: 2 });
        assert.strictEqual(store.get('second'), null);
        assert.deepStrictEqual(store.get('third'), { version: 1 });
    });

    it('removes expired records before enforcing the capacity limit', function() {
        store.put('expired-1', { order: 1 });
        store.put('expired-2', { order: 2 });
        clock += 100;
        store.put('current-1', { order: 3 });
        store.put('current-2', { order: 4 });

        assert.strictEqual(store.get('expired-1'), null);
        assert.strictEqual(store.get('expired-2'), null);
        assert.deepStrictEqual(store.get('current-1'), { order: 3 });
        assert.deepStrictEqual(store.get('current-2'), { order: 4 });
    });
});
