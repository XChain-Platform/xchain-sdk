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
const Utility = require('../../../../src/utils/utility.js');
const Actions = require('../../../../src/actions/index.js');
const { SDKValidationError } = require('../../../../src/utils/errors.js');

const ADDR_A = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
const ADDR_B = '1ExampleAddressXXXXXXXXXXXXXXXXXXX';

function makeActions() {
    const util = new Utility();
    return new Actions({ config: {}, util });
}

function buildSend(params) {
    return makeActions().createAction({ action: 'SEND', params });
}

// createAction end to end

describe('createAction() with legs', function () {

    it('accepts camelCase leg keys and normalizes per-leg amounts', function () {
        const res = buildSend({
            legs: [
                { tick: 'AAA', amount: 5, destination: ADDR_A },
                { tick: 'AAA', amount: '0.00000001', destination: ADDR_B },
            ]
        });
        expect(res.version).to.equal(1);
        expect(res.actionString).to.equal('SEND|1|AAA|5|' + ADDR_A + '|0.00000001|' + ADDR_B);
    });

    it('the built string never repeats a destination the caller did not repeat', function () {
        const res = buildSend({
            tick: 'AAA',
            legs: [{ amount: 5, destination: ADDR_A }, { amount: 1, destination: ADDR_B }]
        });
        const segs = res.actionString.split('|');
        const dests = segs.filter(s => s === ADDR_A || s === ADDR_B);
        expect(dests).to.deep.equal([ADDR_A, ADDR_B]);
    });

    it('a bad leg fails validation before anything is serialized', function () {
        let err = null;
        try {
            buildSend({ tick: 'AAA', legs: [{ amount: 5, destination: ADDR_A }, { amount: 1, destination: 'not-an-address' }] });
        } catch (e) { err = e; }
        expect(err).to.be.instanceOf(SDKValidationError);
        expect(err.message).to.match(/leg 1/);
    });

    it('validateAction dry-runs the leg shape without building', function () {
        const actions = makeActions();
        expect(actions.validateAction('SEND', {
            legs: [{ tick: 'AAA', amount: 5, destination: ADDR_A }, { tick: 'AAA', amount: 1, destination: ADDR_B }]
        }).valid).to.equal(true);
        expect(actions.validateAction('SEND', {
            legs: [{ tick: 'AAA', amount: 5, destination: ADDR_A }, { tick: 'AAA', amount: -1, destination: ADDR_B }]
        }).valid).to.equal(false);
    });

});
