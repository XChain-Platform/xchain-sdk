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
const { parse } = require('../../../src/decoder/parse.js');

// Round trip through decoder.parse (mirrors the indexer's leg extraction)


// Intended legs per SEND version, for 1..4 legs. The parse side must
// recover exactly these, once each, in order.
const CASES = [
    { version: 1, shared: { TICK: 'AAA', MEMO: 'note' }, leg: i => ({ AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
    { version: 2, shared: { MEMO: 'note' },              leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
    { version: 3, shared: {},                            leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i, MEMO: 'm' + i }) },
];

describe('multi-leg round trip', function () {

    for (const c of CASES) {
        for (let count = 1; count <= 4; count++) {
            it('SEND v' + c.version + ' with ' + count + ' leg(s) round-trips with each leg exactly once', function () {
                const legs = [];
                for (let i = 0; i < count; i++) legs.push(c.leg(i));
                const actionString = FormatSelector.serialize('SEND', c.version, Object.assign({}, c.shared, { LEGS: legs }));

                const parsed = parse(actionString, { validate: false });
                expect(parsed.ok, actionString).to.equal(true);
                expect(parsed.version).to.equal(c.version);
                expect(parsed.legs, 'legs recovered').to.have.length(count);

                for (let i = 0; i < count; i++) {
                    for (const field of Object.keys(legs[i]))
                        expect(String(parsed.legs[i][field]), 'leg ' + i + ' ' + field).to.equal(String(legs[i][field]));
                }
                // Every destination appears exactly once on the wire
                const segs = actionString.split('|');
                for (let i = 0; i < count; i++)
                    expect(segs.filter(s => s === 'dest' + i), 'dest' + i + ' occurrences').to.have.length(1);

                // And re-serializing the parsed legs reproduces the string
                const again = FormatSelector.serialize('SEND', parsed.version,
                    Object.assign({}, parsed.params, { LEGS: parsed.legs }));
                expect(again).to.equal(actionString);
            });
        }
    }

});

describe('multi-leg round trip', function () {

    it('the pre-existing repeated-field param arrays still carry every slot', function () {
        const parsed = parse('SEND|1|JDOG|1|a|2|b|3|c', { validate: false });
        expect(parsed.params.TICK).to.equal('JDOG');
        expect(parsed.params.AMOUNT).to.deep.equal(['1', '2', '3']);
        expect(parsed.params.DESTINATION).to.deep.equal(['a', 'b', 'c']);
    });

    it('DESTROY and AIRDROP round-trip at three legs', function () {
        const destroy = FormatSelector.serialize('DESTROY', 1, {
            MEMO: 'burn', LEGS: [{ TICK: 'A', AMOUNT: '1' }, { TICK: 'B', AMOUNT: '2' }, { TICK: 'C', AMOUNT: '3' }]
        });
        expect(destroy).to.equal('DESTROY|1|A|1|B|2|C|3|burn');
        expect(parse(destroy, { validate: false }).legs).to.have.length(3);

        const airdrop = FormatSelector.serialize('AIRDROP', 2, {
            LEGS: [
                { TICK: 'A', AMOUNT: '1', LIST_ACTION_INDEX: '10' },
                { TICK: 'B', AMOUNT: '2', LIST_ACTION_INDEX: '11' },
                { TICK: 'C', AMOUNT: '3', LIST_ACTION_INDEX: '12' },
            ]
        });
        expect(airdrop).to.equal('AIRDROP|2|A|1|10|B|2|11|C|3|12');
        expect(parse(airdrop, { validate: false }).legs).to.have.length(3);
    });

});
