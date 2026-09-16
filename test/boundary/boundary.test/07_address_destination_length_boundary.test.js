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
 * XChain Platform SDK - Boundary Condition Tests
 *
 * Tests exact limit values for OP_RETURN encoding, field lengths,
 * numeric ranges, and format constraints.
 *
 ********************************************************************/

const { expect } = require('chai');
const Utility = require('../../../src/utils/utility.js');
const Validator = require('../../../src/protocol/validator.js');

function createValidator() {
    return new Validator(new Utility());
}

// 42-char segwit address used throughout SEND boundary tests
const DEST_42 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Address length boundary (4 tests)

describe('Address (DESTINATION) length boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    // Helper: validate a SEND with the given destination value
    function destErrors(destination) {
        let errors = validator.validate('SEND', {
            TICK: 'TEST',
            AMOUNT: 100,
            DESTINATION: destination
        });
        return errors.filter(function (e) { return e.details && e.details.field === 'DESTINATION'; });
    }

    it('accepts a 26-character DESTINATION (minimum P2PKH length)', function () {
        // 26 chars = lower bound of the 26-35 P2PKH range
        let addr = '1'.repeat(26);
        expect(destErrors(addr)).to.have.length(0);
    });

    it('accepts a 35-character DESTINATION (maximum P2PKH length)', function () {
        let addr = '1'.repeat(35);
        expect(destErrors(addr)).to.have.length(0);
    });

    it('accepts a 42-character DESTINATION (segwit)', function () {
        expect(destErrors(DEST_42)).to.have.length(0);
    });

    it('rejects a 25-character DESTINATION (one below minimum)', function () {
        let addr = '1'.repeat(25);
        let errs = destErrors(addr);
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});
