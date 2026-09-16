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
const { BET_LIMITS, BET_DETAILS_SCHEMA } = require('../../../../src/actions/betting.js');

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

describe('BET DETAILS market definition', function () {

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

});

describe('BET DETAILS market definition', function () {

    const b = new BettingHelpers();

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

});

describe('BET DETAILS market definition', function () {

    const b = new BettingHelpers();

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
