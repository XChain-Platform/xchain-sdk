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

// MAX_SUPPLY fractional ceiling (4 tests): the whole decimal is compared, as the indexer bcgt does.
describe('MAX_SUPPLY fractional ceiling', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    function maxSupplyErrors(fields) {
        return validator.validate('ISSUE', Object.assign({ TICK: 'TEST' }, fields))
            .filter(function (e) { return e.details && e.details.field === 'MAX_SUPPLY'; });
    }

    it('rejects MAX_SUPPLY = 1 sextillion plus a fraction', function () {
        const halfOver = maxSupplyErrors({ DECIMALS: '1', MAX_SUPPLY: '1000000000000000000000.5' });
        expect(halfOver).to.have.length.greaterThan(0);
        expect(halfOver[0].code).to.equal('INVALID_FIELD_VALUE');
        expect(maxSupplyErrors({ DECIMALS: '18', MAX_SUPPLY: '1000000000000000000000.000000000000000001' })).to.have.length.greaterThan(0);
    });

    it('accepts a fraction at or below the ceiling', function () {
        expect(maxSupplyErrors({ DECIMALS: '18', MAX_SUPPLY: '999999999999999999999.999999999999999999' })).to.have.length(0);
        expect(maxSupplyErrors({ DECIMALS: '1', MAX_SUPPLY: '1000000000000000000000.0' })).to.have.length(0);
    });

    it('names the ceiling as the exact decimal string', function () {
        const over = maxSupplyErrors({ MAX_SUPPLY: '1000000000000000000001' });
        expect(over[0].message).to.contain('1000000000000000000000').and.not.contain('e+21');
        expect(over[0].details.constraint.max).to.equal('1000000000000000000000');
    });

    it('still refuses a negative fraction and a non-numeric value', function () {
        expect(maxSupplyErrors({ MAX_SUPPLY: '-0.5' })).to.have.length.greaterThan(0);
        expect(maxSupplyErrors({ MAX_SUPPLY: 'abc' })[0].message).to.equal('MAX_SUPPLY must be numeric');
    });

});
