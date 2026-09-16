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
const { XChainSDK } = require('../../../../index.js');
const BettingHelpers = require('../../../../src/actions/betting.js');

// A fixed "now" so deadline pre-flight never depends on the wall clock.
const NOW = 1769000000;
const DEADLINE = 1770000000;
const OUTCOMES = ['Chiefs', '49ers'];

function sdk() {
    // compactTickers:false keeps createAction off the network.
    return new XChainSDK({ network: 'bitcoin-mainnet', compactTickers: false });
}

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

function fieldsOf(actionString) {
    return actionString.split('|').slice(1);
}

describe('BET compose', function () {

    it('composes a create with every field populated, in slot order', async function () {
        const s = sdk();
        const result = await s.bet(s.betting.createMarketParams(createParams({
            fee: '2.50',
            refundWindow: 604800,
            minAmount: '10.00000000',
            allowList: 4321,
            blockList: 8765,
            memo: 'Settles from the daily close'
        })));

        expect(result.version).to.equal(0);
        const f = fieldsOf(result.actionString);
        expect(f[0]).to.equal('0');
        expect(f[1]).to.equal('Superbowl LX winner');
        expect(f[2]).to.equal('Chiefs,49ers');
        expect(f[3]).to.equal('PEPECASH');
        expect(f[5]).to.equal(String(DEADLINE));
        expect(f[6]).to.equal('604800');
        expect(f[8]).to.equal('4321');
        expect(f[9]).to.equal('8765');
        expect(f[11]).to.equal('Settles from the daily close');
    });

    it('composes cancel, place, and resolve to their own versions', async function () {
        const s = sdk();

        const cancel = await s.bet(s.betting.cancelMarketParams({ feedActionIndex: 1234, memo: 'Postponed' }));
        expect(cancel.version).to.equal(1);
        expect(cancel.actionString).to.equal('BET|1|1234|Postponed');

        const place = await s.bet(s.betting.placeBetParams({
            feedActionIndex: 1234, outcome: 0, amount: '25.5', memo: 'Chiefs all day'
        }));
        expect(place.version).to.equal(2);
        expect(place.actionString).to.equal('BET|2|1234|0|25.5|Chiefs all day');

        const resolve = await s.bet(s.betting.resolveMarketParams({
            feedActionIndex: 1234, outcome: 1, memo: 'Final 24-21'
        }));
        expect(resolve.version).to.equal(3);
        expect(resolve.actionString).to.equal('BET|3|1234|1|Final 24-21');
    });

});

describe('BET compose', function () {

    it('pins the version rather than inferring it from the fields present', async function () {
        // The sharp edge: {feed, outcome} alone fits BOTH the place-bet and the
        // resolve format, and length-based auto-selection would pick resolve.
        // An oracle resolving a market and a bettor who forgot their stake would
        // then compose the SAME action. The helpers pin `version`, so the two
        // stay distinct even with identical populated fields.
        const s = sdk();
        const resolve = await s.bet(s.betting.resolveMarketParams({ feedActionIndex: 77, outcome: 1 }));
        expect(resolve.version).to.equal(3);

        const inferred = await s.bet({ feedActionIndex: 77, outcome: 1 });
        expect(inferred.version).to.equal(3, 'sanity: without a pinned version this shape reads as a resolve');

        // And a place-bet is unambiguous only because AMOUNT is present.
        const place = await s.bet(s.betting.placeBetParams({ feedActionIndex: 77, outcome: 1, amount: '5' }));
        expect(place.version).to.equal(2);
    });

    it('resolves an outcome label to its wire index when the outcomes are known', function () {
        const b = new BettingHelpers();
        expect(b.placeBetParams({ feedActionIndex: 1, outcome: 'Chiefs', outcomes: OUTCOMES, amount: '1' }).outcome).to.equal('0');
        expect(b.placeBetParams({ feedActionIndex: 1, outcome: '49ers', outcomes: OUTCOMES, amount: '1' }).outcome).to.equal('1');
        // Outcome 0 is falsy and must still compose; an early `if (!outcome)`
        // guard would drop the first outcome of every market.
        expect(b.placeBetParams({ feedActionIndex: 1, outcome: 0, outcomes: OUTCOMES, amount: '1' }).outcome).to.equal('0');
    });

    it('reads a numeric outcome as an index, never as a label', function () {
        // Labels that look like numbers are legal on-chain, so guessing would be
        // ambiguous in exactly the case where guessing wrong loses money.
        const b = new BettingHelpers();
        const numericLabels = ['0', '1'];
        expect(b.outcomeIndex('1', numericLabels)).to.equal(1);
        expect(b.outcomeIndex(1, numericLabels)).to.equal(1);
    });

    it('rejects an outcome index past the end of the market', function () {
        const b = new BettingHelpers();
        expect(() => b.placeBetParams({ feedActionIndex: 1, outcome: 2, outcomes: OUTCOMES, amount: '1' }))
            .to.throw(/out of range/);
        expect(() => b.outcomeIndex('Bengals', OUTCOMES)).to.throw(/not one of/);
    });

});
