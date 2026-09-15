// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const BettingHelpers = require('../../../src/actions/betting.js');

describe('BET payout projection', function () {

    const b = new BettingHelpers();

    it('reproduces the settlement worked example exactly', function () {
        // The shared vector from BET.md §Settlement and the e2e suite: bettor A
        // stakes 10 on outcome 0 when the book already holds 2.5 on outcome 0 and
        // 5 on outcome 1, at a 1% fee and 8 decimals. A's settled payout is
        // 13.86000000; if this projection disagreed, the wallet would quote a
        // number the chain then contradicts.
        const projection = b.projectPayout({ pools: [2.5, 5], outcome: 0, stake: 10, feePct: 1, decimals: 8 });
        expect(projection.total).to.equal('17.50000000');
        expect(projection.winningPool).to.equal('12.50000000');
        expect(projection.fee).to.equal('0.17500000');
        expect(projection.payout).to.equal('13.86000000');
        expect(projection.profit).to.equal('3.86000000');
    });

    it('shows the rake when everyone backs the same outcome', function () {
        // Standard parimutuel behaviour, not a defect: with the whole book on the
        // winner the pot is smaller than the winning pool, so every winner nets a
        // small loss. Surfacing it is the entire reason the wallet projects.
        const projection = b.projectPayout({ pools: [90], outcome: 0, stake: 10, feePct: 1, decimals: 8 });
        expect(Number(projection.payout)).to.be.below(10);
        expect(Number(projection.profit)).to.be.below(0);
    });

    it('floors rather than rounds, matching settlement', function () {
        // A rounding projection overstates the payout by up to one base unit,
        // which reads as the chain shorting the user.
        const projection = b.projectPayout({ pools: [0, 1], outcome: 0, stake: 1, feePct: 0, decimals: 2 });
        // total 2, winning pool 1, so payout = floor(1 * 2 / 1) = 2 exactly.
        expect(projection.payout).to.equal('2.00');

        const thirds = b.projectPayout({ pools: [2, 1], outcome: 0, stake: 1, feePct: 0, decimals: 2 });
        // total 4, winning pool 3: 1 * 4 / 3 = 1.333..., floored to 1.33.
        expect(thirds.payout).to.equal('1.33');
    });

    it('returns fixed-decimal strings, never floats', function () {
        // Amounts can carry 18 decimals and a float projection drifts in the last
        // place, which is precisely where a user compares it to the settled value.
        const projection = b.projectPayout({ pools: [0, 5], outcome: 0, stake: 10, feePct: 1, decimals: 8 });
        for (const key of ['payout', 'profit', 'total', 'winningPool', 'fee'])
            expect(projection[key]).to.be.a('string', key);
        expect(projection.impliedOdds).to.equal('1.48500000');
    });

    it('range-checks its inputs', function () {
        expect(() => b.projectPayout({ pools: 'nope', outcome: 0, stake: 1 })).to.throw(/must be an array/);
        expect(() => b.projectPayout({ pools: [1, 2], outcome: 5, stake: 1 })).to.throw(/out of range/);
        expect(() => b.projectPayout({ pools: [1, 2], outcome: 0, stake: 0 })).to.throw(/must be positive/);
        expect(() => b.projectPayout({ pools: [1], outcome: 0, stake: 1, decimals: 19 })).to.throw(/between 0 and 18/);
    });

});
