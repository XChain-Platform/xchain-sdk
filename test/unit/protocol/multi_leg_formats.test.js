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

const { expect }     = require('chai');
const FormatSelector = require('../../../src/protocol/format_selector.js');
const Validator      = require('../../../src/protocol/validator.js');
const Utility        = require('../../../src/utils/utility.js');
const Actions        = require('../../../src/actions/index.js');
const { parse }      = require('../../../src/decoder/parse.js');
const { SDKFormatError, SDKValidationError } = require('../../../src/utils/errors.js');

// Every repeated-field format in formats.js and the decomposition the
// serializer must derive for it. A new multi-leg format shows up here as a
// failure of the "no other format repeats a field" test below.
const REPEATED = {
    'SEND|1':    { prefix: ['VERSION', 'TICK'],                group: ['AMOUNT', 'DESTINATION'],                       suffix: ['MEMO'] },
    'SEND|2':    { prefix: ['VERSION'],                        group: ['TICK', 'AMOUNT', 'DESTINATION'],               suffix: ['MEMO'] },
    'SEND|3':    { prefix: ['VERSION'],                        group: ['TICK', 'AMOUNT', 'DESTINATION', 'MEMO'],       suffix: [] },
    'DESTROY|1': { prefix: ['VERSION'],                        group: ['TICK', 'AMOUNT'],                              suffix: ['MEMO'] },
    'DESTROY|2': { prefix: ['VERSION'],                        group: ['TICK', 'AMOUNT', 'MEMO'],                      suffix: [] },
    'AIRDROP|1': { prefix: ['VERSION', 'LIST_ACTION_INDEX'],   group: ['TICK', 'AMOUNT'],                              suffix: ['MEMO'] },
    'AIRDROP|2': { prefix: ['VERSION'],                        group: ['TICK', 'AMOUNT', 'LIST_ACTION_INDEX'],         suffix: ['MEMO'] },
    'AIRDROP|3': { prefix: ['VERSION'],                        group: ['TICK', 'AMOUNT', 'LIST_ACTION_INDEX', 'MEMO'], suffix: [] },
};

const ADDR_A = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
const ADDR_B = '1ExampleAddressXXXXXXXXXXXXXXXXXXX';
const ADDR_C = '1Ce9pM5tYhZ2Bqx4NPnRDXtcSHYcv6hs4b';

function makeActions() {
    const util = new Utility();
    return new Actions({ config: {}, util });
}

function buildSend(params) {
    return makeActions().createAction({ action: 'SEND', params });
}


// Group derivation

describe('FormatSelector.getRepeatedGroup()', function () {

    for (const key of Object.keys(REPEATED)) {
        const [action, version] = key.split('|');
        it('decomposes ' + key + ' into prefix | group* | suffix', function () {
            const group = FormatSelector.getRepeatedGroup(action, parseInt(version));
            expect(group, key + ' is a repeated format').to.not.equal(null);
            expect(group.prefix).to.deep.equal(REPEATED[key].prefix);
            expect(group.group).to.deep.equal(REPEATED[key].group);
            expect(group.suffix).to.deep.equal(REPEATED[key].suffix);
        });
    }

    it('returns null for every single-leg format, and flags no format it cannot decompose', function () {
        const formats = require('../../../src/protocol/formats.js');
        const found = [];
        for (const action of Object.keys(formats)) {
            for (const version of Object.keys(formats[action])) {
                // Throws UNSUPPORTED_REPEATED_FORMAT on a repeat it cannot express
                const group = FormatSelector.getRepeatedGroup(action, parseInt(version));
                if (group) found.push(action + '|' + version);
            }
        }
        expect(found.sort()).to.deep.equal(Object.keys(REPEATED).sort());
    });

    it('never places VERSION inside a per-leg group', function () {
        for (const key of Object.keys(REPEATED)) {
            const [action, version] = key.split('|');
            const group = FormatSelector.getRepeatedGroup(action, parseInt(version));
            expect(group.group, key).to.not.include('VERSION');
        }
    });

});


// The loud refusal: a flat map against a repeated-field format

describe('serialize() refuses a flat field map on a repeated format', function () {

    it('SEND v1 fed flat fields throws instead of echoing leg 1', function () {
        let err = null;
        try {
            FormatSelector.serialize('SEND', 1, { TICK: 'XCHAIN', AMOUNT: 5, DESTINATION: ADDR_A, MEMO: 'hi' });
        } catch (e) { err = e; }
        expect(err, 'a flat map must throw').to.be.instanceOf(SDKFormatError);
        expect(err.code).to.equal('REPEATED_FORMAT_REQUIRES_LEGS');
        // The pre-fix output paid ADDR_A twice: 'SEND|1|XCHAIN|5|addr|5|addr|hi'
        expect(err.message).to.match(/LEGS/);
    });

    it('every repeated format refuses a flat map', function () {
        for (const key of Object.keys(REPEATED)) {
            const [action, version] = key.split('|');
            let err = null;
            try {
                FormatSelector.serialize(action, parseInt(version), {
                    TICK: 'TOK', AMOUNT: 1, DESTINATION: ADDR_A, LIST_ACTION_INDEX: 7, MEMO: 'm'
                });
            } catch (e) { err = e; }
            expect(err, key + ' must refuse a flat map').to.be.instanceOf(SDKFormatError);
            expect(err.code, key).to.equal('REPEATED_FORMAT_REQUIRES_LEGS');
        }
    });

    it('parallel arrays in flat fields are refused, not comma-joined into one slot', function () {
        let err = null;
        try {
            FormatSelector.serialize('SEND', 1, {
                TICK: 'XCHAIN', AMOUNT: [5, 1], DESTINATION: [ADDR_A, ADDR_B], MEMO: 'hi'
            });
        } catch (e) { err = e; }
        // Pre-fix: 'SEND|1|XCHAIN|5,1|addrA,addrB|5,1|addrA,addrB|hi'
        expect(err).to.be.instanceOf(SDKFormatError);
        expect(err.code).to.equal('REPEATED_FORMAT_REQUIRES_LEGS');
    });

    it('a single-leg format is unaffected by the guard', function () {
        expect(FormatSelector.serialize('SEND', 0, { TICK: 'XCHAIN', AMOUNT: 5, DESTINATION: ADDR_A }))
            .to.equal('SEND|0|XCHAIN|5|' + ADDR_A);
    });

});
