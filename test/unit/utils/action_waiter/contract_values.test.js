/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/


'use strict';

const assert = require('assert');
const mod = require('../../../../src/utils/action_waiter/contract_values.js');

const { rowsOf, parseStateValue, normalizeContractState, readContractStateValue,
        readContractQuantity, compareAmount } = mod;

function waiterOf(overrides) {
    const hooks = { ...mod, ...overrides };
    hooks.normalizeContractState = raw => normalizeContractState(hooks, raw);
    return hooks;
}

describe('contract value parsing', function () {
    it('rowsOf unwraps arrays and data envelopes', function () {
        const arr = [1];
        assert.strictEqual(rowsOf(arr), arr);
        assert.strictEqual(rowsOf({ data: arr }), arr);
        for (const v of [null, undefined, {}, { data: 'x' }, 'x', 5]) assert.deepStrictEqual(rowsOf(v), []);
    });

    it('parseStateValue parses JSON and passes other values through', function () {
        assert.strictEqual(parseStateValue(undefined), undefined);
        assert.strictEqual(parseStateValue(null), null);
        assert.deepStrictEqual(parseStateValue('{"a":1}'), { a: 1 });
        assert.strictEqual(parseStateValue('5'), 5);
        assert.strictEqual(parseStateValue('not json'), 'not json');
        assert.strictEqual(parseStateValue(7), 7);
        const obj = {};
        assert.strictEqual(parseStateValue(obj), obj);
    });

});

describe('contract state normalization', function () {
    it('normalizeContractState reads rows by either key pair', function () {
        const state = normalizeContractState(mod, [
            { state_key: 'a', state_value: '1' },
            { key: 'b', value: '"x"' },
            null, 'junk', { value: '2' }, { key: null, value: '3' }
        ]);
        assert.deepStrictEqual(Object.keys(state).sort(), ['a', 'b']);
        assert.strictEqual(state.a, 1);
        assert.strictEqual(state.b, 'x');
        assert.strictEqual(Object.getPrototypeOf(state), null);
    });

    it('normalizeContractState reads plain objects and skips envelope keys', function () {
        const raw = { total: 1, page: 1, limit: 1, offset: 0, data: [], results: [], k: '{"n":2}', j: 'z' };
        const state = normalizeContractState(mod, raw);
        assert.deepStrictEqual(Object.keys(state).sort(), ['j', 'k']);
        assert.deepStrictEqual(state.k, { n: 2 });
        assert.strictEqual(Object.getPrototypeOf(state), null);
    });

    it('normalizeContractState is empty for null', function () {
        const state = normalizeContractState(mod, null);
        assert.deepStrictEqual(Object.keys(state), []);
        assert.strictEqual(Object.getPrototypeOf(state), null);
    });

});

describe('contract state reads', function () {
    it('readContractStateValue reads row values', function () {
        const rows = [{ state_key: 'a', state_value: '1' }];
        const waiter = waiterOf();
        assert.strictEqual(readContractStateValue(waiter, rows, 'a'), 1);
        assert.strictEqual(readContractStateValue(waiter, rows, 'missing'), undefined);
    });

    it('readContractStateValue reads a single object', function () {
        assert.strictEqual(readContractStateValue(mod, { state_value: '4' }, 'k'), 4);
        assert.strictEqual(readContractStateValue(mod, { value: '"v"' }, 'k'), 'v');
        assert.strictEqual(readContractStateValue(mod, { k: '{"q":1}' }, 'k').q, 1);
        assert.strictEqual(readContractStateValue(mod, { other: 1 }, 'k'), undefined);
        assert.strictEqual(readContractStateValue(mod, null, 'k'), undefined);
    });

});

describe('contract quantity and amount helpers', function () {
    it('readContractQuantity matches rows by tick and stringifies', function () {
        const rows = [{ tick: 'AAA', quantity: 5 }, { TICK: 'BBB', amount: 1.5 }];
        assert.strictEqual(readContractQuantity(mod, rows, 'AAA'), '5');
        assert.strictEqual(readContractQuantity(mod, rows, 'BBB'), '1.5');
        assert.strictEqual(readContractQuantity(mod, rows, 'CCC'), null);
        assert.strictEqual(readContractQuantity(mod, null, 'AAA'), null);
    });

    it('compareAmount compares exact decimals', function () {
        assert.strictEqual(compareAmount('10', '9'), 1);
        assert.strictEqual(compareAmount('1.0', '1'), 0);
        assert.strictEqual(compareAmount('1', '2'), -1);
        assert.strictEqual(compareAmount('x', '1'), -1);
    });

});

describe('contract value hooks', function () {
    it('routes through the hooks on the object passed as ActionWaiter', function () {
        const hooks = waiterOf({ rowsOf: () => [{ key: 'z', value: '9' }] });
        assert.strictEqual(readContractStateValue(hooks, 'ignored', 'z'), 9);
        assert.strictEqual(mod.rowsOf, rowsOf);
    });
});
