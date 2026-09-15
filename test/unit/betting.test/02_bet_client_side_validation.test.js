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
const { BET_LIMITS } = require('../../../src/actions/betting.js');

// A fixed "now" so deadline pre-flight never depends on the wall clock.
const NOW = 1769000000;
const DEADLINE = 1770000000;
const OUTCOMES = ['Chiefs', '49ers'];

// Minimal valid create params, overridable per test.
function createParams(over = {}) {
    return Object.assign({
        label: 'Superbowl LX winner',
        outcomes: OUTCOMES,
        tick: 'PEPECASH',
        deadline: DEADLINE,
        now: NOW
    }, over);
}

describe('BET client-side validation mirrors the consensus rules', function () {

    const b = new BettingHelpers();

    it('requires a label, outcomes, a tick, and a deadline', function () {
        expect(() => b.createMarketParams(createParams({ label: '' }))).to.throw(/label is required/);
        expect(() => b.createMarketParams(createParams({ deadline: '' }))).to.throw(/deadline is required/);
        expect(() => b.createMarketParams(createParams({ tick: '' }))).to.throw(/token-only/);
    });

    it('rejects native coin as the wager tick', function () {
        // Not an oversight: a native-coin stake cannot be escrowed at parse and
        // would need COINPAY-style obligation machinery that pool betting has no
        // room for. The error says so rather than just "required".
        expect(() => b.createMarketParams(createParams({ tick: '' })))
            .to.throw(/native coin \(empty TICK\) is not supported/);
    });

    it('enforces the outcome count, length, charset, and uniqueness', function () {
        expect(() => b.createMarketParams(createParams({ outcomes: ['OnlyOne'] }))).to.throw(/between 2 and 16/);
        expect(() => b.createMarketParams(createParams({
            outcomes: Array.from({ length: BET_LIMITS.MAX_BET_OUTCOMES + 1 }, (_, i) => 'o' + i)
        }))).to.throw(/between 2 and 16/);
        expect(() => b.createMarketParams(createParams({ outcomes: ['Yes', ''] }))).to.throw(/may not be empty/);
        expect(() => b.createMarketParams(createParams({
            outcomes: ['Yes', 'x'.repeat(BET_LIMITS.MAX_BET_OUTCOME_LENGTH + 1)]
        }))).to.throw(/max 64/);
        expect(() => b.createMarketParams(createParams({ outcomes: ['Yes', 'a|b'] }))).to.throw(/pipe/);
        expect(() => b.createMarketParams(createParams({ outcomes: ['Yes', 'a;b'] }))).to.throw(/semicolon/);
        expect(() => b.createMarketParams(createParams({ outcomes: ['Yes', 'Yes'] }))).to.throw(/duplicate/);
    });

});

describe('BET client-side validation mirrors the consensus rules', function () {

    const b = new BettingHelpers();

    it('allows spaces and ordinary punctuation in outcome labels', function () {
        // The forbidden set is the two delimiters, the comma separator, and
        // control characters. A character-class typo that swallowed spaces would
        // reject most real markets, and every test above would still pass.
        const params = b.createMarketParams(createParams({
            outcomes: ['Kansas City Chiefs', 'San Francisco 49ers (NFC)', 'Draw / tie', 'Over 2.5']
        }));
        expect(params.outcomes).to.equal('Kansas City Chiefs,San Francisco 49ers (NFC),Draw / tie,Over 2.5');
    });

    it('treats case variants as distinct but reports them as an advisory', function () {
        // Consensus compares byte-exact, so Yes/yes is a legal two-outcome
        // market. It is also almost always a mistake, hence a warning, not an error.
        expect(() => b.createMarketParams(createParams({ outcomes: ['Yes', 'yes'] }))).to.not.throw();
        expect(b.outcomeCaseCollisions(['Yes', 'yes', 'No'])).to.deep.equal([['Yes', 'yes']]);
        expect(b.outcomeCaseCollisions(['Yes', 'No'])).to.deep.equal([]);
    });

    it('enforces FEE as a percent with at most two decimals, capped at the maximum', function () {
        expect(b.createMarketParams(createParams({ fee: '1.00' })).fee).to.equal('1.00');
        expect(b.createMarketParams(createParams({ fee: '0' })).fee).to.equal('0');
        expect(() => b.createMarketParams(createParams({ fee: '1.005' }))).to.throw(/at most 2 decimal places/);
        expect(() => b.createMarketParams(createParams({ fee: '-1' }))).to.throw(/at most 2 decimal places/);
        expect(() => b.createMarketParams(createParams({ fee: String(BET_LIMITS.MAX_FEED_FEE + 1) })))
            .to.throw(/exceeds the maximum/);
        // The percent-vs-fraction trap: 0.01 is a hundredth of a PERCENT, and it
        // is legal. An implementation reading FEE as a fraction would take 1%
        // here instead of 0.01%, so the message spells the convention out.
        expect(b.createMarketParams(createParams({ fee: '0.01' })).fee).to.equal('0.01');
    });

    it('enforces the deadline horizon in both directions', function () {
        expect(() => b.createMarketParams(createParams({ deadline: NOW - 1 }))).to.throw(/in the past/);
        expect(() => b.createMarketParams(createParams({ deadline: NOW }))).to.throw(/in the past/);
        expect(() => b.createMarketParams(createParams({ deadline: NOW + 1 }))).to.not.throw();
        expect(() => b.createMarketParams(createParams({
            deadline: NOW + BET_LIMITS.MAX_BET_DEADLINE_HORIZON + 1
        }))).to.throw(/ahead, the protocol maximum/);
        expect(() => b.createMarketParams(createParams({ deadline: '1770000000.5' }))).to.throw(/positive integer/);
    });

});

describe('BET client-side validation mirrors the consensus rules', function () {

    const b = new BettingHelpers();

    it('enforces the refund-window range', function () {
        expect(() => b.createMarketParams(createParams({ refundWindow: BET_LIMITS.MIN_BET_REFUND_WINDOW - 1 })))
            .to.throw(/between 3600 and 31536000/);
        expect(() => b.createMarketParams(createParams({ refundWindow: BET_LIMITS.MAX_BET_REFUND_WINDOW + 1 })))
            .to.throw(/between 3600 and 31536000/);
        expect(b.createMarketParams(createParams({ refundWindow: BET_LIMITS.MIN_BET_REFUND_WINDOW })).refundWindow)
            .to.equal('3600');
        // Omitted means the protocol default (14 days); the SDK sends an empty
        // field rather than materializing the default, so the indexer stays the
        // single place that number lives.
        expect(b.createMarketParams(createParams()).refundWindow).to.equal('');
    });

    it('rejects a market whose allow list and block list are the same list', function () {
        // Such a market looks live in the explorer and can never be bet on; it
        // just burns pass rows until it expires.
        expect(() => b.createMarketParams(createParams({ allowList: 42, blockList: 42 })))
            .to.throw(/Nobody could ever bet/);
        expect(() => b.createMarketParams(createParams({ allowList: 42, blockList: 43 }))).to.not.throw();
    });

    it('rejects non-positive stakes and minimums', function () {
        expect(() => b.createMarketParams(createParams({ minAmount: '0' }))).to.throw(/positive amount/);
        expect(() => b.createMarketParams(createParams({ minAmount: '-5' }))).to.throw(/positive amount/);
        expect(() => b.placeBetParams({ feedActionIndex: 1, outcome: 0, amount: '0' })).to.throw(/positive stake/);
        expect(() => b.placeBetParams({ feedActionIndex: 1, outcome: 0, amount: '-1' })).to.throw(/positive stake/);
        expect(() => b.placeBetParams({ feedActionIndex: 1, outcome: 0 })).to.throw(/amount is required/);
    });

    it('requires a numeric market reference on every lifecycle format', function () {
        for (const build of ['cancelMarketParams', 'resolveMarketParams', 'placeBetParams']) {
            expect(() => b[build]({ feedActionIndex: 'abc', outcome: 0, amount: '1' }))
                .to.throw(/numeric ACTION_INDEX/, build);
            expect(() => b[build]({ outcome: 0, amount: '1' }))
                .to.throw(/FEED_ACTION_INDEX is required/, build);
        }
    });

});
