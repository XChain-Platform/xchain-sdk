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
const { createCoinTickLookup } = require('../../../../src/utils/list/coin_tick_lookup.js');

describe('coin tick lookup', function () {
    it('reads a decimal ticker id with no retry and caches normalized keys', async function () {
        const calls = [];
        const client = {
            getToken: async (rest, options) => {
                calls.push({ rest, options });
                return { info: { tick_id: 12 } };
            }
        };
        const lookup = createCoinTickLookup({
            explorers: { DOGE: client },
            cap: (promise) => promise
        });

        assert.strictEqual(await lookup('DOGE', 'PEPE'), '12');
        assert.strictEqual(await lookup('DOGE', 'PEPE'), '12');
        assert.strictEqual(await lookup('doge', 'pepe'), '12');
        assert.deepStrictEqual(calls, [{ rest: 'PEPE', options: { noRetry: true } }]);
    });

    it('reads the first entry from an array answer', async function () {
        const client = { getToken: async () => [{ info: { tick_id: '13' } }] };
        const lookup = createCoinTickLookup({
            explorers: { DOGE: client },
            cap: (promise) => promise
        });

        assert.strictEqual(await lookup('DOGE', 'ARR'), '13');
    });

    it('does not read when the coin has no usable client', async function () {
        let calls = 0;
        const client = { getToken: async () => { calls += 1; } };
        const lookup = createCoinTickLookup({
            explorers: { DOGE: client, BTC: {} },
            cap: (promise) => promise
        });

        assert.strictEqual(await lookup('LTC', 'PEPE'), null);
        assert.strictEqual(await lookup('BTC', 'PEPE'), null);
        assert.strictEqual(calls, 0);
    });

    it('does not cache a throwing read', async function () {
        let calls = 0;
        const client = {
            getToken: async () => {
                calls += 1;
                throw new Error('unavailable');
            }
        };
        const lookup = createCoinTickLookup({
            explorers: { DOGE: client },
            cap: (promise) => promise
        });

        assert.strictEqual(await lookup('DOGE', 'BOOM'), null);
        assert.strictEqual(await lookup('DOGE', 'BOOM'), null);
        assert.strictEqual(calls, 2);
    });

    it('does not cache a rejected cap', async function () {
        let reads = 0;
        let caps = 0;
        const client = { getToken: async () => { reads += 1; return null; } };
        const lookup = createCoinTickLookup({
            explorers: { DOGE: client },
            cap: () => {
                caps += 1;
                return Promise.reject(new Error('capped'));
            }
        });

        assert.strictEqual(await lookup('DOGE', 'SLOW'), null);
        assert.strictEqual(await lookup('DOGE', 'SLOW'), null);
        assert.strictEqual(reads, 2);
        assert.strictEqual(caps, 2);
    });

    it('does not cache a missing or non-numeric id', async function () {
        let calls = 0;
        const client = {
            getToken: async (rest) => {
                calls += 1;
                return rest === 'BAD' ? { info: { tick_id: 'x1' } } : null;
            }
        };
        const lookup = createCoinTickLookup({
            explorers: { DOGE: client },
            cap: (promise) => promise
        });

        assert.strictEqual(await lookup('DOGE', 'BAD'), null);
        assert.strictEqual(await lookup('DOGE', 'BAD'), null);
        assert.strictEqual(await lookup('DOGE', 'NONE'), null);
        assert.strictEqual(await lookup('DOGE', 'NONE'), null);
        assert.strictEqual(calls, 4);
    });

    it('requires an explorer map and cap function', function () {
        assert.throws(() => createCoinTickLookup({ explorers: null, cap: () => {} }), TypeError);
        assert.throws(() => createCoinTickLookup({ explorers: {}, cap: null }), TypeError);
    });
});
