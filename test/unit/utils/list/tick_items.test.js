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
const {
    LIST_TICK_LOOKUP_CONCURRENCY,
    compactTickItems
} = require('../../../../src/utils/list/tick_items.js');

async function rewritesEligibleItems() {
    const lookup = async (coin, rest) => {
        if (coin === 'DOGE' && rest === 'PEPE') return 12;
        if (coin === 'BTC' && rest === 'foo') return '5';
        return null;
    };

    assert.deepStrictEqual(
        await compactTickItems(['DOGE:PEPE', 'btc:foo'], lookup),
        ['DOGE:^12', 'BTC:^5']
    );
}

async function leavesIneligibleItemsUntouched() {
    const items = ['PEPE', 'ETH:FOO', 'DOGE:^7', 'LTC:a b'];
    let calls = 0;
    const output = await compactTickItems(items, async () => {
        calls += 1;
        return 9;
    });

    assert.deepStrictEqual(output, items);
    assert.notStrictEqual(output, items);
    assert.strictEqual(calls, 0);
}

async function keepsItemsForFailedLookups() {
    const items = ['LTC:NONE', 'DOGE:ZERO', 'DOGE:BOOM'];
    const output = await compactTickItems(items, async (coin, rest) => {
        if (rest === 'ZERO') return 0;
        if (rest === 'BOOM') throw new Error('lookup failed');
        return null;
    });

    assert.deepStrictEqual(output, items);
}

async function rejectsInvalidLookupIds() {
    const answers = new Map([
        ['ZEROES', '05'],
        ['UNSAFE', '9007199254740992'],
        ['FLOAT', 1.5]
    ]);
    const items = ['BTC:ZEROES', 'LTC:UNSAFE', 'DOGE:FLOAT'];

    assert.deepStrictEqual(
        await compactTickItems(items, async (coin, rest) => answers.get(rest)),
        items
    );
}

async function keepsOrderWithoutMutation() {
    const items = ['DOGE:SLOW', 'PEPE', 'LTC:FAST'];
    const copy = items.slice();
    const output = await compactTickItems(items, async (coin, rest) => {
        await new Promise(resolve => setTimeout(resolve, rest === 'SLOW' ? 15 : 1));
        return rest === 'SLOW' ? 2 : 3;
    });

    assert.deepStrictEqual(output, ['DOGE:^2', 'PEPE', 'LTC:^3']);
    assert.deepStrictEqual(items, copy);
}

async function limitsConcurrentLookups() {
    assert.strictEqual(LIST_TICK_LOOKUP_CONCURRENCY, 8);
    let active = 0;
    let maximum = 0;
    const items = Array.from({ length: 20 }, (_, index) => 'DOGE:N' + index);

    const output = await compactTickItems(items, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return null;
    });

    assert.deepStrictEqual(output, items);
    assert.strictEqual(maximum, LIST_TICK_LOOKUP_CONCURRENCY);
}

describe('list tick items', function () {
    it('rewrites eligible coin-qualified items with canonical lookup ids', rewritesEligibleItems);
    it('leaves bare, future-root, id-form and malformed items untouched', leavesIneligibleItemsUntouched);
    it('keeps the original item for null, zero and thrown lookup results', keepsItemsForFailedLookups);
    it('rejects non-canonical and unsafe lookup ids', rejectsInvalidLookupIds);
    it('keeps item order and does not mutate the input array', keepsOrderWithoutMutation);
    it('runs no more than eight lookups at once', limitsConcurrentLookups);
});
