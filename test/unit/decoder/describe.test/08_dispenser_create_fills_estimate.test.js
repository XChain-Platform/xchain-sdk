'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

// Read the 'Estimated fills' line off a v0 dispenser create preview, or undefined when absent.
function fills(giveEscrow, giveAmount) {
    const d = describeAction({ action: 'DISPENSER', params: {
        VERSION: '0', GIVE_TICK: 'TOK', GIVE_AMOUNT: giveAmount, GIVE_ESCROW: giveEscrow,
        GET_COIN: 'BTC', GET_AMOUNT: '1000',
    } });
    const row = d.details.find(x => x.label === 'Estimated fills');
    return row ? row.value : undefined;
}

describe('describe: DISPENSER v0 create fills estimate', function () {

    // The indexer floors the exact quotient (bcfloor(bcdiv(remaining, amount, 64))),
    // so the signing preview must agree with it rather than with IEEE-754 division.
    it('counts every fill a decimal escrow covers when the double quotient lands just below it', function () {
        expect(fills('0.3', '0.1')).to.equal('3');
        expect(fills('0.7', '0.1')).to.equal('7');
        expect(fills('10', '3')).to.equal('3');
    });

    it('does not promise a fill an 18-decimal escrow falls short of', function () {
        expect(fills('2.999999999999999999', '1')).to.equal('2');
    });

    it('keeps counts above 2^53 exact', function () {
        expect(fills('90071992547409930', '1')).to.equal('90071992547409930');
    });

    // Number(' 5') read padded input fine, and a raw bignumber parse of it throws, which would crash the preview.
    it('still renders a whitespace-padded escrow instead of throwing', function () {
        expect(fills(' 5', '0.1')).to.equal('50');
    });

    it('omits the line when the per-fill amount is zero or a value is not numeric', function () {
        expect(fills('10', '0')).to.equal(undefined);
        expect(fills('abc', '1')).to.equal(undefined);
        expect(fills('10', '')).to.equal(undefined);
    });
});
