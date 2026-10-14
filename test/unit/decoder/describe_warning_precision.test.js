'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { describe: describeAction } = require('../../../src/decoder/describe.js');
const { isNotPositive, isLessThan, fractionToPercent } = require('../../../src/decoder/describe/value_format.js');

describe('decoder.describe warnings use exact decimal comparison', function () {
    it('isNotPositive treats a sub-double amount as positive and empty or zero as not', function () {
        expect(isNotPositive('0.000000000000000001')).to.equal(false);
        expect(isNotPositive('0')).to.equal(true);
        expect(isNotPositive('')).to.equal(true);
        expect(isNotPositive('-1')).to.equal(true);
    });

    it('isLessThan separates values a double cannot', function () {
        // The second collapses to 9007199254740992 as doubles.
        expect(Number('9007199254740992') < Number('9007199254740993')).to.equal(false);
        expect(isLessThan('9007199254740992', '9007199254740993')).to.equal(true);
        expect(isLessThan('0.3', '0.30000000000000004')).to.equal(true);
    });

    it('fractionToPercent renders the percentage with 2 decimals trimmed', function () {
        expect(fractionToPercent('0.01')).to.equal('1');
        expect(fractionToPercent('0.0125')).to.equal('1.25');
        expect(fractionToPercent('1')).to.equal('100');
    });

    it('dispenser create warns when the escrow is one unit short of a huge fill that doubles cannot tell apart', function () {
        const decoded = describeAction({ action: 'DISPENSER', params: {
            VERSION: '0', GIVE_TICK: 'TOK', GIVE_AMOUNT: '9007199254740993', GIVE_ESCROW: '9007199254740992',
            GET_COIN: 'BTC', GET_AMOUNT: '1000',
        } });
        expect(decoded.warnings.join('|')).to.include('Escrow is smaller than a single fill');
    });

});

describe('decoder.describe warnings on non-numeric and padded values', function () {
    it('non-numeric input answers false to every comparison', function () {
        for (const bad of ['abc', 'NaN', 'Infinity', '1,5']) {
            expect(isNotPositive(bad), bad).to.equal(false);
            expect(isLessThan(1, bad), bad).to.equal(false);
            expect(isLessThan(bad, 1), bad).to.equal(false);
        }
    });

    it('a non-numeric dispenser escrow gets no new positivity or size warning', function () {
        const decoded = describeAction({ action: 'DISPENSER', params: {
            VERSION: '0', GIVE_TICK: 'TOK', GIVE_AMOUNT: '5', GIVE_ESCROW: 'abc', GET_COIN: 'BTC', GET_AMOUNT: '1000',
        } });
        const text = decoded.warnings.join('|');
        expect(text).to.not.include('Escrow amount is not positive');
        expect(text).to.not.include('Escrow is smaller than a single fill');
    });

    it('fractionToPercent trims, never throws, and never shows a nonzero fraction as 0%', function () {
        expect(fractionToPercent('1 ')).to.equal('100');
        expect(fractionToPercent(' 1')).to.equal('100');
        expect(fractionToPercent('abc')).to.equal(null);
        expect(fractionToPercent('0.00004')).to.equal('0.004');
        expect(fractionToPercent('0.0125')).to.equal('1.25');
    });

    it('PRICE with a padded or tiny FEE describes without throwing', function () {
        const price = (fee) => describeAction({ action: 'PRICE', version: 1, params: {
            VERSION: '1', TICK: 'TOK', FIAT_CODE: 'USD', VALUE: '1.5', FEE: fee,
        } });
        const fees = (fee) => price(fee).details.map((d) => d.value).join('|');
        expect(() => price('1 ')).to.not.throw();
        expect(() => price(' 1')).to.not.throw();
        expect(fees('0.00004')).to.include('0.004%');
    });
});
