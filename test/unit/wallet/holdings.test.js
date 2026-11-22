// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');

const { holdingFromBalances } = require('../../../src/utils/wallet/holdings.js');

function registerComparisonTests() {
    it('holds when an amount is exactly the minimum', function () {
        const result = holdingFromBalances([{ tick: 'XCP', amount: '1' }], 'XCP', '1');

        assert.strictEqual(result.holds, true);
    });

    it('does not hold when an amount is below the minimum', function () {
        const result = holdingFromBalances([{ tick: 'XCP', amount: '0.99999999' }], 'XCP', '1');

        assert.strictEqual(result.holds, false);
    });

    it('matches ticks exactly without case folding', function () {
        const result = holdingFromBalances([{ tick: 'XCP', amount: '10' }], 'xcp', '1');

        assert.strictEqual(result.amount.eq(0), true);
        assert.strictEqual(result.holds, false);
    });
}

function registerAmountTests() {
    it('accepts a non-negative finite number minimum', function () {
        const result = holdingFromBalances([{ tick: 'XCP', amount: '1.5' }], 'XCP', 1.5);

        assert.strictEqual(result.holds, true);
    });

    it('preserves precision beyond the JavaScript integer range', function () {
        const result = holdingFromBalances(
            [{ tick: 'XCP', amount: '100000000000000000.00000001' }],
            'XCP',
            '100000000000000000'
        );

        assert.strictEqual(result.holds, true);
    });

    it('does not round a slightly smaller fractional amount up to the minimum', function () {
        const result = holdingFromBalances(
            [{ tick: 'XCP', amount: '0.10000000000000000001' }],
            'XCP',
            '0.10000000000000000002'
        );

        assert.strictEqual(result.holds, false);
    });

    it('returns zero for an absent tick and only holds at a zero minimum', function () {
        const atZero = holdingFromBalances([], 'XCP', '0');
        const aboveZero = holdingFromBalances([], 'XCP', '0.00000001');

        assert.strictEqual(atZero.amount.eq(0), true);
        assert.strictEqual(atZero.holds, true);
        assert.strictEqual(aboveZero.amount.eq(0), true);
        assert.strictEqual(aboveZero.holds, false);
    });

    it('sums duplicate matching rows', function () {
        const result = holdingFromBalances([
            { tick: 'XCP', amount: '0.4' },
            { tick: 'XCP', amount: '0.6' },
        ], 'XCP', '1');

        assert.strictEqual(result.amount.eq(1), true);
        assert.strictEqual(result.holds, true);
    });

    it('returns the matching amount as a BigNumber', function () {
        const result = holdingFromBalances([{ tick: 'XCP', amount: '12.345' }], 'XCP', '0');

        assert.strictEqual(result.amount.isBigNumber, true);
        assert.strictEqual(result.amount.eq('12.345'), true);
    });
}

function registerValidationTests() {
    it('rejects invalid rows, tick, and minimum inputs', function () {
        const invalidCalls = [
            () => holdingFromBalances({}, 'XCP', '1'),
            () => holdingFromBalances([], '', '1'),
            () => holdingFromBalances([], 'XCP', -1),
            () => holdingFromBalances([], 'XCP', '-1'),
            () => holdingFromBalances([], 'XCP', NaN),
            () => holdingFromBalances([], 'XCP', Infinity),
            () => holdingFromBalances([], 'XCP', '1e3'),
            () => holdingFromBalances([], 'XCP', ''),
        ];

        for (const call of invalidCalls)
            assert.throws(call, TypeError);
    });

    it('rejects an invalid amount on a matching row and names the tick', function () {
        assert.throws(
            () => holdingFromBalances([{ tick: 'XCP', amount: 'abc' }], 'XCP', '1'),
            (error) => error instanceof TypeError && /XCP/.test(error.message)
        );
    });
}

describe('holdingFromBalances', function () {
    registerComparisonTests();
    registerAmountTests();
    registerValidationTests();
});
