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

// Lock field boundary (3 tests)

describe('Lock field boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    // Helper: validate an ISSUE with a specific LOCK_MAX_SUPPLY value
    function lockErrors(value) {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', LOCK_MAX_SUPPLY: value });
        return errors.filter(function (e) { return e.details && e.details.field === 'LOCK_MAX_SUPPLY'; });
    }

    it('accepts LOCK_MAX_SUPPLY = 0 (unlocked)', function () {
        expect(lockErrors(0)).to.have.length(0);
    });

    it('accepts LOCK_MAX_SUPPLY = 1 (locked)', function () {
        expect(lockErrors(1)).to.have.length(0);
    });

    it('rejects LOCK_MAX_SUPPLY = 2 (smallest invalid value)', function () {
        let errs = lockErrors(2);
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});
