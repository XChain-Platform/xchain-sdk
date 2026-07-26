// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// BET (parimutuel betting) SDK surface,  P5.
//
// Two things are under test and they fail differently. The COMPOSE half must put
// exactly the right bytes in exactly the right slots: BET has three formats that
// all lead with FEED_ACTION_INDEX and differ only by which trailing fields are
// present, so a resolve with a stray AMOUNT silently becomes a place-bet, and a
// place-bet with no OUTCOME silently becomes a cancel. The VALIDATE half must
// reject every §6 violation client-side, because the alternative is paying a fee
// to be rejected on-chain, and it must reject NOTHING consensus accepts, because
// that blocks legitimate markets with no recourse.

const { expect } = require('chai');
const { XChainSDK } = require('../../index.js');
const BettingHelpers = require('../../src/betting.js');
const { BET_LIMITS, BET_DETAILS_SCHEMA } = require('../../src/betting.js');
const formats = require('../../src/formats.js');

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

describe('BET formats ', function () {

    it('registers all four formats with the field order BET.md declares', function () {
        expect(formats.BET[0]).to.equal(
            'VERSION|LABEL|OUTCOMES|TICK|FEE|DEADLINE|REFUND_WINDOW|MIN_AMOUNT|ALLOW_LIST|BLOCK_LIST|DETAILS|MEMO');
        expect(formats.BET[1]).to.equal('VERSION|FEED_ACTION_INDEX|MEMO');
        expect(formats.BET[2]).to.equal('VERSION|FEED_ACTION_INDEX|OUTCOME|AMOUNT|MEMO');
        expect(formats.BET[3]).to.equal('VERSION|FEED_ACTION_INDEX|OUTCOME|MEMO');
    });

    it('has no edit format: markets are immutable from creation', function () {
        // Reinstating one would reopen the first-bettor edit race, which is why
        // the whole FEED_HASH apparatus was cut. If a v4 appears, that decision
        // is being reversed and the spec needs revisiting first.
        expect(Object.keys(formats.BET)).to.deep.equal(['0', '1', '2', '3']);
    });

});

describe('BET compose ', function () {

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

describe('BET client-side validation mirrors the consensus rules ', function () {

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

describe('BET DETAILS market definition ', function () {

    const b = new BettingHelpers();

    it('builds strict, canonical base64 of a JSON object', function () {
        const encoded = b.buildBetDetails({ title: 'Who wins?' });
        expect(encoded).to.match(/^[A-Za-z0-9+/]*={0,2}$/);
        expect(encoded.length % 4).to.equal(0);
        expect(Buffer.from(encoded, 'base64').toString('base64')).to.equal(encoded);
        expect(b.parseBetDetails(encoded)).to.deep.equal({ title: 'Who wins?' });
    });

    it('requires a title and type-checks every documented key', function () {
        expect(() => b.buildBetDetails({})).to.throw(/title is required/);
        expect(() => b.buildBetDetails({ title: '   ' })).to.throw(/title is required/);
        expect(() => b.buildBetDetails({ title: 42 })).to.throw(/must be a string/);
        expect(() => b.buildBetDetails({ title: 'x', category: 7 })).to.throw(/category must be a string/);
        expect(() => b.buildBetDetails({ title: 'x', outcome_details: 'not an array' }))
            .to.throw(/must be an array of strings/);
        expect(() => b.buildBetDetails({ title: 'x', description: 'd'.repeat(2001) }))
            .to.throw(/description is \d+ characters/);
    });

    it('keeps unknown keys so a market can carry application data', function () {
        // Consensus never looks at them, so refusing them would be the SDK being
        // stricter than the protocol.
        const parsed = b.parseBetDetails(b.buildBetDetails({ title: 'x', house_specific: { id: 9 } }));
        expect(parsed.house_specific).to.deep.equal({ id: 9 });
    });

    it('cross-checks DETAILS.outcomes against OUTCOMES byte-for-byte', function () {
        // The whole point of composing the two together: a market whose printed
        // outcomes differ from the ones bets settle against is rejected on-chain.
        expect(() => b.buildBetDetails({ title: 'x', outcomes: ['Chiefs', 'Niners'] }, { outcomes: OUTCOMES }))
            .to.throw(/must match the OUTCOMES field exactly/);
        expect(() => b.buildBetDetails({ title: 'x', outcomes: ['49ers', 'Chiefs'] }, { outcomes: OUTCOMES }))
            .to.throw(/must match the OUTCOMES field exactly/, 'order matters');
        expect(() => b.buildBetDetails({ title: 'x', outcomes: ['Chiefs'] }, { outcomes: OUTCOMES }))
            .to.throw(/must match the OUTCOMES field exactly/, 'count matters');
        expect(() => b.buildBetDetails({ title: 'x', outcomes: 'Chiefs,49ers' }, { outcomes: OUTCOMES }))
            .to.throw(/must be an array/, 'present-but-not-an-array is a mismatch');

        // Absent is filled in from the canonical outcomes, which is how the
        // wallet form gets them right without the user retyping them.
        const filled = b.parseBetDetails(b.buildBetDetails({ title: 'x' }, { outcomes: OUTCOMES }));
        expect(filled.outcomes).to.deep.equal(OUTCOMES);
    });

    it('rejects an outcome_details array that does not line up with the outcomes', function () {
        expect(() => b.buildBetDetails({ title: 'x', outcome_details: ['only one'] }, { outcomes: OUTCOMES }))
            .to.throw(/outcome_details has 1 entries for 2 outcomes/);
    });

    it('enforces the size cap on the DECODED payload', function () {
        // Padded through an UNKNOWN key, which carries no per-key length rule, so
        // this exercises the total-size cap rather than the description cap.
        const skeleton = { title: 'x', pad: '' };
        const room = BET_LIMITS.MAX_BET_DETAILS_LENGTH - Buffer.byteLength(JSON.stringify(skeleton), 'utf8');

        expect(() => b.buildBetDetails({ title: 'x', pad: 'd'.repeat(room + 1) }))
            .to.throw(/DETAILS is \d+ bytes, max 4096/);

        // At the cap exactly: still accepted, and it round-trips.
        const encoded = b.buildBetDetails({ title: 'x', pad: 'd'.repeat(room) });
        expect(Buffer.from(encoded, 'base64').length).to.equal(BET_LIMITS.MAX_BET_DETAILS_LENGTH);
        expect(b.parseBetDetails(encoded).pad.length).to.equal(room);

        // And the per-key caps still bite independently.
        expect(() => b.buildBetDetails({ title: 'x', description: 'd'.repeat(2001) }))
            .to.throw(/description is 2001 characters/);
    });

    it('caps nesting depth on both the build and the parse path', function () {
        // The cap bounds the recursion this validator, the wallet form, and the
        // explorer renderer perform on attacker-chosen on-chain input.
        let deep = 'leaf';
        for (let i = 0; i < BET_LIMITS.MAX_BET_DETAILS_DEPTH + 2; i++) deep = { nested: deep };
        expect(() => b.buildBetDetails({ title: 'x', extra: deep })).to.throw(/nests \d+ levels deep/);

        const hostile = Buffer.from(JSON.stringify({ title: 'x', extra: deep }), 'utf8').toString('base64');
        expect(() => b.parseBetDetails(hostile)).to.throw(/nests deeper than/);
    });

    it('rejects hostile DETAILS on the parse path', function () {
        const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
        expect(() => b.parseBetDetails('not base64!')).to.throw(/strict base64/);
        expect(() => b.parseBetDetails('abcde')).to.throw(/strict base64/, 'length must be a multiple of 4');
        expect(() => b.parseBetDetails(Buffer.from('{"a":', 'utf8').toString('base64')))
            .to.throw(/not parseable JSON/);
        expect(() => b.parseBetDetails(b64(['array', 'top', 'level']))).to.throw(/must decode to a JSON object/);
        expect(() => b.parseBetDetails(b64('bare string'))).to.throw(/must decode to a JSON object/);
        expect(() => b.parseBetDetails(b64(42))).to.throw(/must decode to a JSON object/);
        expect(() => b.parseBetDetails(b64(null))).to.throw(/must decode to a JSON object/);
    });

    it('rejects non-canonical base64 that decodes anyway', function () {
        // Buffer.from is lenient: it accepts padding and alphabet variations that
        // do not re-encode to themselves. Consensus requires a byte-identical
        // round-trip, so the SDK has to check the round-trip, not just decodability.
        const canonical = Buffer.from(JSON.stringify({ title: 'x' }), 'utf8').toString('base64');
        expect(() => b.parseBetDetails(canonical)).to.not.throw();
        const urlSafe = canonical.replace(/\+/g, '-').replace(/\//g, '_');
        if (urlSafe !== canonical) expect(() => b.parseBetDetails(urlSafe)).to.throw(/strict base64/);
    });

    it('exposes the schema as data, and hands out copies', function () {
        // Wallet forms and the docs are generated from this, so it has to be
        // introspectable; handing out the live object would let one caller's edit
        // change every other caller's validation.
        expect(BET_DETAILS_SCHEMA.title.required).to.equal(true);
        const copy = b.DETAILS_SCHEMA;
        copy.title.required = false;
        expect(b.DETAILS_SCHEMA.title.required).to.equal(true);
        expect(b.LIMITS.MAX_BET_DETAILS_LENGTH).to.equal(4096);
    });

    it('validates a pre-encoded DETAILS string passed straight to createMarketParams', function () {
        const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
        expect(() => b.createMarketParams(createParams({ details: b64({ title: 'x', outcomes: ['Wrong', 'Labels'] }) })))
            .to.throw(/must match the OUTCOMES field exactly/);
        expect(() => b.createMarketParams(createParams({ details: 'not base64!' }))).to.throw(/strict base64/);
        const ok = b.createMarketParams(createParams({ details: b64({ title: 'x', outcomes: OUTCOMES }) }));
        expect(b.parseBetDetails(ok.details).outcomes).to.deep.equal(OUTCOMES);
    });

    it('composes DETAILS and OUTCOMES together so they cannot disagree', async function () {
        const s = sdk();
        const result = await s.bet(s.betting.createMarketParams(createParams({
            details: { title: 'Who wins Superbowl LX?', category: 'sports' }
        })));
        const f = fieldsOf(result.actionString);
        expect(s.betting.parseBetDetails(f[10]).outcomes).to.deep.equal(f[2].split(','));
    });

});

describe('BET action-level validation ', function () {

    it('accepts a well-formed create and rejects the documented violations', function () {
        const s = sdk();
        const base = {
            label: 'Superbowl LX winner', outcomes: 'Chiefs,49ers', tick: 'PEPECASH',
            fee: '1.00', deadline: String(DEADLINE)
        };
        expect(s.validateAction('BET', base).valid).to.equal(true);

        const codes = params => s.validateAction('BET', Object.assign({}, base, params)).errors.map(e => e.code);
        expect(codes({ label: '' })).to.include('MISSING_REQUIRED_FIELD');
        expect(codes({ outcomes: 'OnlyOne' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ outcomes: 'Yes,Yes' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ fee: '1.005' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ fee: '99' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ deadline: 'soon' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ refundWindow: '60' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ minAmount: '0' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ allowList: '5', blockList: '5' })).to.include('INVALID_FIELD_VALUE');
        expect(codes({ details: 'not base64!' })).to.include('INVALID_FIELD_VALUE');
    });

    it('does not demand create fields on the lifecycle formats', function () {
        // FEED_ACTION_INDEX marks an index operation, which exempts the create
        // required-field set. Without that entry every cancel would report four
        // spurious missing-field errors.
        const s = sdk();
        expect(s.validateAction('BET', { feedActionIndex: '1234' }).valid).to.equal(true);
        expect(s.validateAction('BET', { feedActionIndex: '1234', outcome: '1' }).valid).to.equal(true);
        expect(s.validateAction('BET', { feedActionIndex: '1234', outcome: '0', amount: '5' }).valid).to.equal(true);
    });

    it('rejects an AMOUNT with no OUTCOME, which would silently become a cancel', function () {
        const s = sdk();
        const res = s.validateAction('BET', { feedActionIndex: '1234', amount: '25' });
        expect(res.valid).to.equal(false);
        expect(res.errors.map(e => e.code)).to.include('MISSING_REQUIRED_FIELD');
    });

    it('rejects delimiters in the memo, like every other action', function () {
        const s = sdk();
        expect(s.validateAction('BET', { feedActionIndex: '1234', memo: 'a|b' }).valid).to.equal(false);
        expect(s.validateAction('BET', { feedActionIndex: '1234', memo: 'a;b' }).valid).to.equal(false);
    });

});

describe('BET payout projection ', function () {

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

describe('BET client surfaces ', function () {

    it('exposes the explorer read endpoints on the route paths the explorer registers', async function () {
        const s = sdk();
        const calls = [];
        // Stub the transport: this asserts the PATH each helper builds, which is
        // the half that silently 404s if it drifts from the explorer route map.
        s.explorer = { _get: async (path) => { calls.push(path); return {}; } };
        Object.setPrototypeOf(s.explorer, require('../../src/explorer.js').prototype);

        await s.explorer.getBetFeeds('open', 'status');
        await s.explorer.getBetFeed(1234);
        await s.explorer.getBets('1234', 'feed');
        await s.explorer.getOracleStats('1ExampleOracleAddress');

        expect(calls).to.deep.equal([
            '/bet_feeds/open/status',
            '/bet_feed/1234',
            '/bets/1234/feed',
            '/oracle/1ExampleOracleAddress'
        ]);
    });

    it('builds the bet_feed websocket subscription the way the server accepts it', function () {
        const WebSocketClient = require('../../src/websocket.js');
        const sent = [];
        const client = Object.create(WebSocketClient.prototype);
        client.subscribe = (channels, params) => { sent.push(['sub', channels, params]); };
        client.unsubscribe = (channels, params) => { sent.push(['unsub', channels, params]); };

        client.subscribeBetFeed(1234);
        client.unsubscribeBetFeed('1234');

        // BARE channel name, market id in params. This assertion previously pinned
        // the composite form `['bet_feed:1234']`, which the explorer rejects with
        // `Unknown channel` before it ever looks at the entity key: entity channels
        // are validated against a fixed name set and take their key from params
        // (ChannelManager). A mock-only test could assert either shape happily,
        // which is exactly how the wrong one shipped; test/sdk/betWebsocket.sdk.test.js
        // is the counterpart that talks to the real server.
        expect(sent).to.deep.equal([
            ['sub',   ['bet_feed'], { action_index: '1234' }],
            ['unsub', ['bet_feed'], { action_index: '1234' }],
        ]);

        // Caller params survive alongside the id rather than being replaced.
        sent.length = 0;
        client.subscribeBetFeed(7, { types: ['BET'] });
        expect(sent).to.deep.equal([['sub', ['bet_feed'], { types: ['BET'], action_index: '7' }]]);

        // A bad index would subscribe to a channel that never fires, and the
        // page would just sit there looking live.
        expect(() => client.subscribeBetFeed('abc')).to.throw(/numeric ACTION_INDEX/);
        expect(() => client.subscribeBetFeed(null)).to.throw(/numeric ACTION_INDEX/);
    });

    it('exposes betting on the sdk instance and a raw bet() wrapper', async function () {
        const s = sdk();
        expect(s.betting).to.be.an('object');
        expect(s.getActions()).to.include('BET');
        expect(s.getActionFormats('BET')).to.have.keys(['0', '1', '2', '3']);
        const result = await s.bet({ version: 1, feedActionIndex: 1234 });
        expect(result.actionString).to.equal('BET|1|1234');
    });

    it('wires the workflow recipes to the pinned-version builders', function () {
        const s = sdk();
        for (const name of ['openMarket', 'placeBet', 'resolveMarket', 'cancelMarket'])
            expect(s.workflows[name]).to.be.a('function', name);
    });

});
