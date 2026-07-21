'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Display-hardening unit suite (spec §3.5): bidi/zero-width
// neutralization, canonical amount rendering flags, shared address
// truncation. Adversarial fixtures live here permanently.

const { expect } = require('chai');
const {
    sanitizeText, formatAmount, truncateAddress, BIDI_PLACEHOLDER,
} = require('../../../src/decoder/hardening.js');

describe('decoder hardening', function () {

    describe('sanitizeText', function () {
        it('replaces bidi controls with a visible placeholder and flags', function () {
            const flags = [];
            const out = sanitizeText('pay‮gro.live‬ to me', flags);
            expect(out).to.not.include('‮');
            expect(out).to.include(BIDI_PLACEHOLDER);
            expect(flags.some(f => /direction-control/.test(f))).to.equal(true);
        });

        it('strips zero-width characters and flags', function () {
            const flags = [];
            const out = sanitizeText('JD​OG', flags);
            expect(out).to.equal('JDOG');
            expect(flags.some(f => /zero-width/.test(f))).to.equal(true);
        });

        it('is stateless across calls (no /g lastIndex leakage)', function () {
            for (let i = 0; i < 5; i++) {
                const flags = [];
                sanitizeText('‮aa‮', flags);
                expect(flags).to.have.length(1);
            }
        });

        it('clean text passes through unflagged', function () {
            const flags = [];
            expect(sanitizeText('hello world', flags)).to.equal('hello world');
            expect(flags).to.deep.equal([]);
        });
    });

    describe('formatAmount', function () {
        it('flags exponential notation, never prettifies', function () {
            const flags = [];
            expect(formatAmount('1e21', null, flags)).to.equal('1e21');
            expect(flags.some(f => /exponential/.test(f))).to.equal(true);
        });

        it('flags non-numeric junk', function () {
            const flags = [];
            formatAmount('12abc', null, flags);
            expect(flags.some(f => /not a plain decimal/.test(f))).to.equal(true);
        });

        it('flags negative amounts as non-plain', function () {
            const flags = [];
            formatAmount('-5', null, flags);
            expect(flags).to.not.be.empty;
        });

        it('precision beyond DECIMALS is flagged', function () {
            const flags = [];
            expect(formatAmount('1.123456789', 8, flags)).to.equal('1.123456789');
            expect(flags.some(f => /more decimal places/.test(f))).to.equal(true);
        });

        it('unknown DECIMALS (null) renders raw with precision-unverified flag', function () {
            const flags = [];
            expect(formatAmount('1.5', null, flags)).to.equal('1.5');
            expect(flags.some(f => /could not be verified/.test(f))).to.equal(true);
        });

        it('NaN sentinel skips precision checks but keeps junk flags', function () {
            const flags = [];
            expect(formatAmount('1.5', NaN, flags)).to.equal('1.5');
            expect(flags).to.deep.equal([]);
            formatAmount('1e5', NaN, flags);
            expect(flags).to.not.be.empty;
        });

        it('integer within decimals passes clean', function () {
            const flags = [];
            expect(formatAmount('21000000', 8, flags)).to.equal('21000000');
            expect(flags).to.deep.equal([]);
        });
    });

    describe('truncateAddress', function () {
        it('shared head-8/tail-6 window', function () {
            const a = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
            const t = truncateAddress(a);
            expect(t).to.equal('bc1qw508…v8f3t4');
        });
        it('short values pass through', function () {
            expect(truncateAddress('short')).to.equal('short');
        });
        it('bidi in an address is neutralized and flagged', function () {
            const flags = [];
            const t = truncateAddress('bc1q‮xxxxxxxxxxxxxxxxxxxxxx', flags);
            expect(t).to.not.include('‮');
            expect(flags).to.not.be.empty;
        });
    });
});
