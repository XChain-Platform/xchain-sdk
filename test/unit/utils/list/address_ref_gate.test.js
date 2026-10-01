// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
    listAddressRefActive,
    shouldCompactListItems
} = require('../../../../src/utils/list/address_ref_gate.js');
const { mapWithLimit } = require('../../../../src/utils/list/map_limit.js');

describe('list address reference gate', function () {
    it('activates at and above the threshold, but not one block below', function () {
        assert.strictEqual(listAddressRefActive(100, 98), false);
        assert.strictEqual(listAddressRefActive(100, 99), true);
        assert.strictEqual(listAddressRefActive(100, 100), true);
    });

    it('keeps an unreached sentinel threshold inactive', function () {
        assert.strictEqual(listAddressRefActive(9999999999, 500), false);
    });

    it('fails closed for missing, null and string inputs', function () {
        assert.strictEqual(listAddressRefActive(undefined, 500), false);
        assert.strictEqual(listAddressRefActive(null, 500), false);
        assert.strictEqual(listAddressRefActive('100', 99), false);
        assert.strictEqual(listAddressRefActive(100, undefined), false);
        assert.strictEqual(listAddressRefActive(100, null), false);
        assert.strictEqual(listAddressRefActive(100, '99'), false);
    });

    it('compacts only type 2 list items when the gate is active', function () {
        assert.strictEqual(shouldCompactListItems({ listType: 1, threshold: 0, lastBlock: 5 }), false);
        assert.strictEqual(shouldCompactListItems({ listType: 2, threshold: 0, lastBlock: 5 }), true);
        assert.strictEqual(shouldCompactListItems({ listType: '2', threshold: 0, lastBlock: 5 }), true);
        assert.strictEqual(shouldCompactListItems({ listType: 3, threshold: 0, lastBlock: 5 }), false);
        assert.strictEqual(shouldCompactListItems({ listType: null, threshold: 0, lastBlock: 5 }), false);
        assert.strictEqual(shouldCompactListItems({ listType: 2, threshold: 10, lastBlock: 8 }), false);
    });
});

describe('mapWithLimit', function () {
    it('preserves input order across callbacks that finish out of order', async function () {
        const output = await mapWithLimit([30, 10, 20], 3, async (delay, index) => {
            await new Promise(resolve => setTimeout(resolve, delay));
            return index + ':' + delay;
        });

        assert.deepStrictEqual(output, ['0:30', '1:10', '2:20']);
    });

    it('never exceeds the in-flight limit', async function () {
        let active = 0;
        let maximum = 0;
        const items = Array.from({ length: 20 }, (_, index) => index);

        const output = await mapWithLimit(items, 8, async (item) => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return item * 2;
        });

        assert.deepStrictEqual(output, items.map(item => item * 2));
        assert.strictEqual(maximum, 8);
    });

    it('rejects immediately with the first callback error', async function () {
        const expected = new Error('lookup failed');
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        const timeout = new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('rejection was delayed')), 100);
        });

        try {
            await assert.rejects(
                Promise.race([
                    mapWithLimit([0, 1, 2], 2, async (item) => {
                        if (item === 1) throw expected;
                        await blocked;
                        return item;
                    }),
                    timeout
                ]),
                error => error === expected
            );
        } finally {
            release();
        }
    });
});
