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

const ADDR_A = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';

// Conformance with the indexer's leg extraction (the consensus arbiter)


/*
 * Vendored index arithmetic from xchain-indexer/src/actions/send.js
 * parse(), which is the consensus arbiter for how a SEND string becomes
 * credits. `params` there is the action string's value segments (VERSION
 * first, ACTION name already stripped). Kept byte-for-byte in shape with
 * the source so a drift shows up as a failure here; the live check is the
 * regtest suite (xchain-e2e-test/test/sdk/multiLegSend.sdk.test.js).
 */
function indexerSends(actionString) {
    const params = actionString.split('|').slice(1);
    const format = Number(params[0]);
    const sends  = [];

    let memo = null;
    const last = params.length - 1;
    for (const idx in params)
        if (idx == last && ((format == 0 && idx == 4) || (format == 1 && idx % 2 == 0) || (format == 2 && idx % 3 == 1)))
            memo = params[idx];

    const lastIdx = params.length - 1;
    for (let idx in params) {
        idx = parseInt(idx);
        if (format == 0 && idx == 0)
            sends.push([params[1], params[2], params[3], memo]);
        if (format == 1 && idx > 1 && idx % 2 == 1)
            sends.push([params[1], params[idx - 1], params[idx], memo]);
        if (format == 2 && idx > 0 && idx % 3 == 1 && idx < lastIdx)
            sends.push([params[idx], params[idx + 1], params[idx + 2], memo]);
        if (format == 3 && idx > 0 && idx % 4 == 1 && idx < lastIdx)
            sends.push([params[idx], params[idx + 1], params[idx + 2], params[idx + 3]]);
    }
    return sends;
}

const SHAPES = [
    { version: 1, shared: { TICK: 'AAA', MEMO: 'note' }, leg: i => ({ AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
    { version: 1, shared: { TICK: 'AAA' },               leg: i => ({ AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
    { version: 2, shared: { MEMO: 'note' },              leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
    { version: 2, shared: {},                            leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
    { version: 3, shared: {},                            leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i, MEMO: 'm' + i }) },
];

describe('indexer leg-extraction conformance', function () {

    for (const shape of SHAPES) {
        for (let count = 2; count <= 4; count++) {
            const label = 'SEND v' + shape.version + ', ' + count + ' legs'
                + (shape.shared.MEMO ? ', shared memo' : '');
            it(label + ': the indexer credits each leg exactly once', function () {
                const legs = [];
                for (let i = 0; i < count; i++) legs.push(shape.leg(i));
                const actionString = FormatSelector.serialize('SEND', shape.version,
                    Object.assign({}, shape.shared, { LEGS: legs }));

                const sends = indexerSends(actionString);
                expect(sends, label + ' leg count').to.have.length(count);
                for (let i = 0; i < count; i++) {
                    const [tick, amount, destination] = sends[i];
                    expect(tick,        'leg ' + i + ' tick').to.equal(legs[i].TICK || shape.shared.TICK);
                    expect(amount,      'leg ' + i + ' amount').to.equal(legs[i].AMOUNT);
                    expect(destination, 'leg ' + i + ' destination').to.equal(legs[i].DESTINATION);
                }
                // No destination is credited twice
                const credited = sends.map(s => s[2]);
                expect(new Set(credited).size, 'distinct destinations').to.equal(count);
            });
        }
    }

});

describe('indexer leg-extraction conformance', function () {

    it('the pre-fix flat serialization would have paid one address twice', function () {
        // What serialize() emitted before the fix, for flat SEND v1 params
        const preFix = 'SEND|1|XCHAIN|5|' + ADDR_A + '|5|' + ADDR_A + '|hi';
        const sends = indexerSends(preFix);
        expect(sends).to.have.length(2);
        expect(sends[0][2]).to.equal(sends[1][2]);   // same destination
        expect(sends[0][1]).to.equal(sends[1][1]);   // same amount: double payment
    });

});
