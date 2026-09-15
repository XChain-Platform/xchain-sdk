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

// DECIMALS boundary (4 tests)

describe('DECIMALS boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    it('accepts DECIMALS = 0', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: 0 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length(0);
    });

    it('accepts DECIMALS = 18 (maximum valid)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: 18 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length(0);
    });

    it('rejects DECIMALS = 19 (one above maximum)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: 19 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length.greaterThan(0);
        expect(decErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('rejects DECIMALS = -1 (below minimum)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: -1 });
        let decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length.greaterThan(0);
        expect(decErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});
