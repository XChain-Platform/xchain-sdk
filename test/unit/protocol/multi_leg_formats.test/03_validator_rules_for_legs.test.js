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
const Validator = require('../../../../src/protocol/validator.js');
const Utility = require('../../../../src/utils/utility.js');

const ADDR_A = '1BoogrfDADPLQpq8LMASmWQUVYDp4t2hF9';
const ADDR_B = '1ExampleAddressXXXXXXXXXXXXXXXXXXX';

// Validator rules


const validator = new Validator(new Utility());

describe('validator rules for LEGS', function () {

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

});

describe('validator rules for LEGS', function () {

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
