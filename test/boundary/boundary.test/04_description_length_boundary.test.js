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

// DESCRIPTION length boundary (3 tests)

describe('DESCRIPTION length boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    it('accepts DESCRIPTION of exactly 250 characters (maximum valid)', function () {
        let description = 'D'.repeat(250);
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DESCRIPTION: description });
        let descErrors = errors.filter(function (e) { return e.details && e.details.field === 'DESCRIPTION'; });
        expect(descErrors).to.have.length(0);
    });

    it('rejects DESCRIPTION of exactly 251 characters (one above maximum)', function () {
        let description = 'D'.repeat(251);
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DESCRIPTION: description });
        let descErrors = errors.filter(function (e) { return e.details && e.details.field === 'DESCRIPTION'; });
        expect(descErrors).to.have.length.greaterThan(0);
        expect(descErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('accepts DESCRIPTION of exactly 249 characters (one below maximum)', function () {
        let description = 'D'.repeat(249);
        let errors = validator.validate('ISSUE', { TICK: 'TEST', DESCRIPTION: description });
        let descErrors = errors.filter(function (e) { return e.details && e.details.field === 'DESCRIPTION'; });
        expect(descErrors).to.have.length(0);
    });

});
