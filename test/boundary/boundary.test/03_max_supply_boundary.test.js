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

// MAX_SUPPLY boundary (4 tests)

describe('MAX_SUPPLY boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    it('accepts MAX_SUPPLY = 1000000000000000000000 (exactly 1 sextillion)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '1000000000000000000000' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length(0);
    });

    it('rejects MAX_SUPPLY = 1000000000000000000001 (1 sextillion + 1)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '1000000000000000000001' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length.greaterThan(0);
        expect(supErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('accepts MAX_SUPPLY = 999999999999999999999 (one below ceiling)', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '999999999999999999999' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length(0);
    });

    it('accepts MAX_SUPPLY = 0', function () {
        let errors = validator.validate('ISSUE', { TICK: 'TEST', MAX_SUPPLY: '0' });
        let supErrors = errors.filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
        expect(supErrors).to.have.length(0);
    });

});
