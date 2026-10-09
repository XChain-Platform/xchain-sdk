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
    it('normalizeContractState reads the explorer state columns only', function () {
        const state = normalizeContractState(mod, [
            { state_key: 'a', state_value: '1' },
            { key: 'b', value: '"x"' },
            null, 'junk', { value: '2' }, { key: null, value: '3' }
        ]);
        assert.deepStrictEqual(Object.keys(state), ['a']);
        assert.strictEqual(state.a, 1);
        assert.strictEqual(Object.getPrototypeOf(state), null);
    });

    it('normalizeContractState ignores objects outside the explorer list shape', function () {
        const raw = { total: 1, page: 1, limit: 1, offset: 0, data: [], results: [], k: '{"n":2}', j: 'z' };
        const state = normalizeContractState(mod, raw);
        assert.deepStrictEqual(Object.keys(state), []);
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

    it('readContractStateValue ignores non-explorer objects', function () {
        const waiter = waiterOf();
        assert.strictEqual(readContractStateValue(waiter, { state_value: '4' }, 'k'), undefined);
        assert.strictEqual(readContractStateValue(waiter, { value: '"v"' }, 'k'), undefined);
        assert.strictEqual(readContractStateValue(waiter, { k: '{"q":1}' }, 'k'), undefined);
        assert.strictEqual(readContractStateValue(waiter, null, 'k'), undefined);
    });

});

describe('contract quantity and amount helpers', function () {
    it('readContractQuantity reads the explorer balance columns only', function () {
        const rows = [
            { tick: 'AAA', amount: 5 },
            { tick: 'BBB', quantity: 1.5 },
            { TICK: 'CCC', amount: 2 }
        ];
        assert.strictEqual(readContractQuantity(mod, rows, 'AAA'), '5');
        assert.strictEqual(readContractQuantity(mod, rows, 'BBB'), null);
        assert.strictEqual(readContractQuantity(mod, rows, 'CCC'), null);
        assert.strictEqual(readContractQuantity(mod, null, 'AAA'), null);
        assert.strictEqual(readContractQuantity(mod, { tick: 'AAA', amount: '5' }, 'AAA'), null);
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
        const hooks = waiterOf({ rowsOf: () => [{ state_key: 'z', state_value: '9' }] });
        assert.strictEqual(readContractStateValue(hooks, 'ignored', 'z'), 9);
        assert.strictEqual(mod.rowsOf, rowsOf);
    });
});

describe('contract reads over the explorer list envelope', function () {
    const EMPTY = { total: 0, data: [], runtime: '1ms', freshness: { stale: true } };

    it('readContractStateValue never reads an envelope key as contract state', function () {
        for (const key of ['total', 'data', 'runtime', 'freshness', 'page', 'limit', 'offset', 'results'])
            assert.strictEqual(readContractStateValue(waiterOf(), EMPTY, key), undefined, key);
        assert.strictEqual(readContractStateValue(waiterOf(), [], 'length'), undefined);
    });

    it('normalizeContractState leaves runtime and freshness out of an empty page', function () {
        assert.deepStrictEqual(Object.keys(normalizeContractState(mod, EMPTY)), []);
    });

    it('a state gate on a key named like an envelope field stays unsatisfied on an empty page', function () {
        const { classifyState } = require('../../../../src/utils/action_waiter/contract_wait.js');
        const hooks = waiterOf();
        hooks.readContractStateValue = (raw, key) => readContractStateValue(hooks, raw, key);
        assert.strictEqual(classifyState(hooks, EMPTY, 'total', {}, 7, () => false).satisfied, false);
    });

    it('reads the state and amount columns the explorer serves', function () {
        const state = { total: 1, data: [{ id: '3', contract_index: '7', state_key: 'k', state_value: '{"n":2}', block_index: '9' }] };
        assert.deepStrictEqual(readContractStateValue(waiterOf(), state, 'k'), { n: 2 });
        const balance = { total: 1, data: [{ tick: 'AAA', amount: '12.50000000' }] };
        assert.strictEqual(readContractQuantity(mod, balance, 'AAA'), '12.50000000');
    });
});
