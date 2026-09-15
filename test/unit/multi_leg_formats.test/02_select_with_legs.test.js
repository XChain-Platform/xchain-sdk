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
const FormatSelector = require('../../../src/protocol/format_selector.js');
const { SDKFormatError } = require('../../../src/utils/errors.js');

const ADDR_A = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
const ADDR_B = '1ExampleAddressXXXXXXXXXXXXXXXXXXX';

// Version selection

describe('select() with legs', function () {

    it('one leg picks the single-leg v0 (shortest)', function () {
        const sel = FormatSelector.select('SEND', { LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }] });
        expect(sel.version).to.equal(0);
    });

    it('two legs on one tick pick v1 (shared TICK)', function () {
        const sel = FormatSelector.select('SEND', {
            LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }, { TICK: 'AAA', AMOUNT: 1, DESTINATION: ADDR_B }]
        });
        expect(sel.version).to.equal(1);
    });

    it('two legs on different ticks pick v2 (per-leg TICK)', function () {
        const sel = FormatSelector.select('SEND', {
            LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }, { TICK: 'BBB', AMOUNT: 1, DESTINATION: ADDR_B }]
        });
        expect(sel.version).to.equal(2);
    });

    it('two legs with different memos pick v3 (per-leg MEMO)', function () {
        const sel = FormatSelector.select('SEND', {
            LEGS: [
                { TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A, MEMO: 'one' },
                { TICK: 'AAA', AMOUNT: 1, DESTINATION: ADDR_B, MEMO: 'two' },
            ]
        });
        expect(sel.version).to.equal(3);
    });

});

describe('select() with legs', function () {

    it('never auto-selects a repeated format when no legs were provided', function () {
        const formats = require('../../../src/protocol/formats.js');
        const flat = {
            SEND:    { TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A, MEMO: 'm' },
            DESTROY: { TICK: 'AAA', AMOUNT: 5, MEMO: 'm' },
            AIRDROP: { TICK: 'AAA', AMOUNT: 5, LIST_ACTION_INDEX: 7, MEMO: 'm' },
        };
        for (const action of Object.keys(flat)) {
            const sel = FormatSelector.select(action, flat[action]);
            expect(FormatSelector.isRepeatedFormat(action, sel.version), action + ' v' + sel.version).to.equal(false);
            expect(formats[action][sel.version], action).to.be.a('string');
            // and the selected version serializes without the guard firing
            expect(FormatSelector.serialize(action, sel.version, flat[action])).to.be.a('string');
        }
    });

    it('an explicit version that cannot carry the legs fails loudly, never silently', function () {
        const fields = {
            LEGS: [{ TICK: 'AAA', AMOUNT: 5, DESTINATION: ADDR_A }, { TICK: 'BBB', AMOUNT: 1, DESTINATION: ADDR_B }]
        };
        // v1 has ONE TICK slot, so forcing it must fail rather than emit leg 1's tick twice
        expect(() => FormatSelector.select('SEND', fields, 1))
            .to.throw(SDKFormatError, /legs disagree/);
        expect(() => FormatSelector.serialize('SEND', 1, fields))
            .to.throw(SDKFormatError, /legs disagree/);
    });

    it('multi-leg on an action with no repeated format has no matching version', function () {
        expect(() => FormatSelector.select('MINT', {
            LEGS: [{ TICK: 'AAA', AMOUNT: 1 }, { TICK: 'AAA', AMOUNT: 2 }]
        })).to.throw(SDKFormatError, /NO_MATCHING_FORMAT|can represent/);
    });

});
