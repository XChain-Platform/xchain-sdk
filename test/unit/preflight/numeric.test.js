'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Numeric-semantics suite (spec §4.5): arbitrary precision only,
// floor-not-round distributions, and the vendored amount-format rule.

const { expect } = require('chai');
const numeric = require('../../../src/preflight/numeric.js');

describe('pre-flight numeric semantics', function () {

    it('compares beyond 2^53 without precision loss', function () {
        // Two values that collapse to the same JS double but differ.
        const a = '9007199254740993';   // 2^53 + 1
        const b = '9007199254740992';   // 2^53
        expect(numeric.gt(a, b)).to.equal(true);
        expect(numeric.gte(b, a)).to.equal(false);
    });

    it('16+ significant-digit fractional comparison is exact', function () {
        expect(numeric.gte('1.0000000000000001', '1')).to.equal(true);
        expect(numeric.gte('1', '1.0000000000000001')).to.equal(false);
    });

    it('isPositive', function () {
        expect(numeric.isPositive('0.00000001')).to.equal(true);
        expect(numeric.isPositive('0')).to.equal(false);
        expect(numeric.isPositive('-1')).to.equal(false);
    });

    it('add/sub are exact decimal', function () {
        expect(numeric.add('0.1', '0.2')).to.equal('0.3');
        expect(numeric.sub('100', '0.00000001')).to.equal('99.99999999');
    });

    it('mulFloor floors, never rounds (distribution rule §4.5.4)', function () {
        // 3 units * 0.333333 per-unit at 2 decimals = 0.999999 -> floor 0.99
        expect(numeric.mulFloor('3', '0.333333', 2)).to.equal('0.99');
        // exact multiples are unaffected
        expect(numeric.mulFloor('4', '0.25', 2)).to.equal('1');
    });

    it('vendored isValidAmountFormat rejects over-precision and negatives', function () {
        expect(numeric.isValidAmountFormat(2, '1.234')).to.equal(false); // 3 dp > 2
        expect(numeric.isValidAmountFormat(2, '1.23')).to.equal(true);
        expect(numeric.isValidAmountFormat(0, '1.5')).to.equal(false);   // indivisible
        expect(numeric.isValidAmountFormat(8, '-1')).to.equal(false);
    });
});
