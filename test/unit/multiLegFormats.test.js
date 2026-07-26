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
 * spells out the canonical two. Before  the serializer walked the
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
const FormatSelector = require('../../src/formatSelector.js');
const Validator      = require('../../src/validator.js');
const Utility        = require('../../src/utility.js');
const Actions        = require('../../src/actions.js');
const { parse }      = require('../../src/decoder/parse.js');
const { SDKFormatError, SDKValidationError } = require('../../src/errors.js');

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


// ===========================================================================
// Group derivation
// ===========================================================================

describe(' FormatSelector.getRepeatedGroup()', function () {

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
        const formats = require('../../src/formats.js');
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


// ===========================================================================
// The loud refusal: a flat map against a repeated-field format
// ===========================================================================

describe(' serialize() refuses a flat field map on a repeated format', function () {

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


// ===========================================================================
// Per-leg expansion
// ===========================================================================

describe(' serialize() expands LEGS positionally', function () {

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


// ===========================================================================
// Version selection
// ===========================================================================

describe(' select() with legs', function () {

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

    it('never auto-selects a repeated format when no legs were provided', function () {
        const formats = require('../../src/formats.js');
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


// ===========================================================================
// Validator rules
// ===========================================================================

describe(' validator rules for LEGS', function () {

    const validator = new Validator(new Utility());

    it('accepts a well-formed multi-leg SEND', function () {
        const errors = validator.validate('SEND', {
            LEGS: [
                { TICK: 'AAA', AMOUNT: '5', DESTINATION: ADDR_A },
                { TICK: 'AAA', AMOUNT: '1', DESTINATION: ADDR_B },
            ]
        });
        expect(errors).to.deep.equal([]);
    });

    it('a required field missing from ONE leg is reported with its leg index', function () {
        const errors = validator.validate('SEND', {
            LEGS: [{ TICK: 'AAA', AMOUNT: '5' }, { TICK: 'AAA', AMOUNT: '1', DESTINATION: ADDR_B }]
        });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD');
        expect(missing).to.have.length(1);
        expect(missing[0].details.field).to.equal('DESTINATION');
        expect(missing[0].details.legs).to.deep.equal([0]);
    });

    it('a shared top-level TICK satisfies the per-leg requirement', function () {
        const errors = validator.validate('SEND', {
            TICK: 'AAA',
            LEGS: [{ AMOUNT: '5', DESTINATION: ADDR_A }, { AMOUNT: '1', DESTINATION: ADDR_B }]
        });
        expect(errors).to.deep.equal([]);
    });

    it('a non-positive AMOUNT on leg 2 is caught, not just leg 1', function () {
        const errors = validator.validate('SEND', {
            TICK: 'AAA',
            LEGS: [{ AMOUNT: '5', DESTINATION: ADDR_A }, { AMOUNT: '0', DESTINATION: ADDR_B }]
        });
        const bad = errors.filter(e => e.code === 'INVALID_FIELD_VALUE' && e.details.field === 'AMOUNT');
        expect(bad).to.have.length(1);
        expect(bad[0].details.leg).to.equal(1);
    });

    it('a pipe injected into a later leg is caught', function () {
        const errors = validator.validate('SEND', {
            TICK: 'AAA',
            LEGS: [{ AMOUNT: '5', DESTINATION: ADDR_A }, { AMOUNT: '1', DESTINATION: ADDR_B, MEMO: 'a|b' }]
        });
        expect(errors.some(e => e.details.field === 'MEMO' && e.details.leg === 1)).to.equal(true);
    });

    it('LEGS shape problems are validation errors, not crashes', function () {
        for (const bad of ['nope', [], [null], [{ AMOUNT: [1, 2] }]]) {
            const errors = validator.validate('SEND', { TICK: 'AAA', DESTINATION: ADDR_A, AMOUNT: '1', LEGS: bad });
            expect(errors.some(e => e.code === 'INVALID_LEGS'), JSON.stringify(bad)).to.equal(true);
        }
    });

    it('multi-leg on an action with no repeated format is a validation error', function () {
        const errors = validator.validate('MINT', {
            LEGS: [{ TICK: 'AAA', AMOUNT: '1' }, { TICK: 'AAA', AMOUNT: '2' }]
        });
        expect(errors.some(e => e.code === 'INVALID_LEGS')).to.equal(true);
    });

});


// ===========================================================================
// createAction end to end
// ===========================================================================

describe(' createAction() with legs', function () {

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


// ===========================================================================
// Round trip through decoder.parse (mirrors the indexer's leg extraction)
// ===========================================================================

describe(' multi-leg round trip', function () {

    // Intended legs per SEND version, for 1..4 legs. The parse side must
    // recover exactly these, once each, in order.
    const CASES = [
        { version: 1, shared: { TICK: 'AAA', MEMO: 'note' }, leg: i => ({ AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
        { version: 2, shared: { MEMO: 'note' },              leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i }) },
        { version: 3, shared: {},                            leg: i => ({ TICK: 'T' + i, AMOUNT: String(i + 1), DESTINATION: 'dest' + i, MEMO: 'm' + i }) },
    ];

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


// ===========================================================================
// Conformance with the indexer's leg extraction (the consensus arbiter)
// ===========================================================================

describe(' indexer leg-extraction conformance', function () {

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

    it('the pre-fix flat serialization would have paid one address twice', function () {
        // What serialize() emitted before  for flat SEND v1 params
        const preFix = 'SEND|1|XCHAIN|5|' + ADDR_A + '|5|' + ADDR_A + '|hi';
        const sends = indexerSends(preFix);
        expect(sends).to.have.length(2);
        expect(sends[0][2]).to.equal(sends[1][2]);   // same destination
        expect(sends[0][1]).to.equal(sends[1][1]);   // same amount: double payment
    });

});
