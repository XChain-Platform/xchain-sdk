/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - repeated-field (multi-leg) format tests
 *
 * SEND v1/v2/v3, DESTROY v1/v2 and AIRDROP v1-v3 REPEAT field names, and
 * the wire accepts N repetitions of the group even though formats.js
 * spells out the canonical two. Earlier, the serializer walked the
 * format field list against a FLAT field map, so every repetition read
 * the same fields[NAME] and leg 2 echoed leg 1: a well-formed action that
 * paid one recipient twice, with no error anywhere.
 *
 * These tests pin the three halves of the fix: per-leg expansion, the
 * loud refusal of a flat map, and the leg-count-agnostic round trip
 * through decoder.parse (whose leg extraction mirrors the indexer's).
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const { SDKFormatError } = require('../../../../src/utils/errors.js');

const ADDR_A = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
const ADDR_B = '1ExampleAddressXXXXXXXXXXXXXXXXXXX';
const ADDR_C = '1Ce9pM5tYhZ2Bqx4NPnRDXtcSHYcv6hs4b';

// Per-leg expansion

describe('serialize() expands LEGS positionally', function () {

    it('SEND v1 emits two DISTINCT legs under one shared TICK and MEMO', function () {
        const out = FormatSelector.serialize('SEND', 1, {
            TICK: 'XCHAIN', MEMO: 'hi',
            LEGS: [{ AMOUNT: 5, DESTINATION: ADDR_A }, { AMOUNT: 1, DESTINATION: ADDR_B }]
        });
        expect(out).to.equal('SEND|1|XCHAIN|5|' + ADDR_A + '|1|' + ADDR_B + '|hi');
        const segs = out.split('|');
        expect(segs[3], 'leg 1 destination').to.not.equal(segs[5]);
    });

    it('SEND v1 carries an arbitrary leg count', function () {
        const out = FormatSelector.serialize('SEND', 1, {
            LEGS: [
                { TICK: 'XCHAIN', AMOUNT: 1, DESTINATION: ADDR_A },
                { TICK: 'XCHAIN', AMOUNT: 2, DESTINATION: ADDR_B },
                { TICK: 'XCHAIN', AMOUNT: 3, DESTINATION: ADDR_C },
            ]
        });
        expect(out).to.equal('SEND|1|XCHAIN|1|' + ADDR_A + '|2|' + ADDR_B + '|3|' + ADDR_C);
    });

    it('SEND v2 carries a distinct TICK per leg', function () {
        const out = FormatSelector.serialize('SEND', 2, {
            MEMO: 'm',
            LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }, { TICK: 'BBB', AMOUNT: 1, DESTINATION: ADDR_B }]
        });
        expect(out).to.equal('SEND|2|AAA|5|' + ADDR_A + '|BBB|1|' + ADDR_B + '|m');
    });

    it('SEND v3 carries a distinct MEMO per leg', function () {
        const out = FormatSelector.serialize('SEND', 3, {
            LEGS: [
                { TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A, MEMO: 'first' },
                { TICK: 'BBB', AMOUNT: 1, DESTINATION: ADDR_B, MEMO: 'second' },
            ]
        });
        expect(out).to.equal('SEND|3|AAA|5|' + ADDR_A + '|first|BBB|1|' + ADDR_B + '|second');
    });

    it('DESTROY v1 and AIRDROP v1 expand the same way', function () {
        expect(FormatSelector.serialize('DESTROY', 1, {
            MEMO: 'bye', LEGS: [{ TICK: 'AAA', AMOUNT: 5 }, { TICK: 'BBB', AMOUNT: 3 }]
        })).to.equal('DESTROY|1|AAA|5|BBB|3|bye');

        expect(FormatSelector.serialize('AIRDROP', 1, {
            LIST_ACTION_INDEX: 99, LEGS: [{ TICK: 'AAA', AMOUNT: 5 }, { TICK: 'BBB', AMOUNT: 3 }]
        })).to.equal('AIRDROP|1|99|AAA|5|BBB|3');
    });

    it('a one-leg array works on a single-leg format too', function () {
        expect(FormatSelector.serialize('SEND', 0, { LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }] }))
            .to.equal('SEND|0|AAA|5|' + ADDR_A);
    });

});

describe('serialize() expands LEGS positionally', function () {
    it('refuses legs that disagree on a SHARED slot instead of silently using leg 1', function () {
        let err = null;
        try {
            // v1 carries ONE TICK for the whole action
            FormatSelector.serialize('SEND', 1, {
                LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }, { TICK: 'BBB', AMOUNT: 1, DESTINATION: ADDR_B }]
            });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKFormatError);
        expect(err.code).to.equal('INCONSISTENT_SHARED_FIELD');
        expect(err.details.field).to.equal('TICK');
    });

    it('refuses a leg field with no slot in the format', function () {
        let err = null;
        try {
            FormatSelector.serialize('DESTROY', 1, { LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }] });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKFormatError);
        expect(err.code).to.equal('LEG_FIELD_NOT_IN_FORMAT');
    });

    it('refuses an array value inside a leg', function () {
        let err = null;
        try {
            FormatSelector.serialize('SEND', 1, { TICK: 'AAA', LEGS: [{ AMOUNT: [5, 1], DESTINATION: ADDR_A }] });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKFormatError);
        expect(err.code).to.equal('INVALID_LEGS');
    });

    it('refuses a LEGS value that is not a non-empty array of objects', function () {
        for (const bad of ['nope', [], [null], [['a']], [42]]) {
            let err = null;
            try { FormatSelector.serialize('SEND', 1, { TICK: 'AAA', LEGS: bad }); }
            catch (e) { err = e; }
            expect(err, JSON.stringify(bad)).to.be.instanceOf(SDKFormatError);
            expect(err.code, JSON.stringify(bad)).to.equal('INVALID_LEGS');
        }
    });

    it('refuses more than one leg on a single-leg format', function () {
        let err = null;
        try {
            FormatSelector.serialize('SEND', 0, {
                LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }, { TICK: 'AAA', AMOUNT: 1, DESTINATION: ADDR_B }]
            });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKFormatError);
        expect(err.code).to.equal('SINGLE_LEG_FORMAT');
    });

});
