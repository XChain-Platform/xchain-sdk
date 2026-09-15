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

// FIAT_AMOUNT format boundary (5 tests)

describe('FIAT_AMOUNT format boundary', function () {

    let validator;

    before(function () {
        validator = createValidator();
    });

    // Helper: run validate with a DISPENSER skeleton so FIAT_AMOUNT is evaluated
    function fiatErrors(amount) {
        let errors = validator.validate('DISPENSER', {
            GIVE_TICK: 'BTC',
            GIVE_AMOUNT: 1,
            GET_TICK: 'LTC',
            GET_AMOUNT: 1,
            FIAT_CODE: 'USD',
            FIAT_AMOUNT: amount
        });
        return errors.filter(function (e) { return e.details && e.details.field === 'FIAT_AMOUNT'; });
    }

    it("accepts FIAT_AMOUNT '0.00' (zero with two decimal places)", function () {
        expect(fiatErrors('0.00')).to.have.length(0);
    });

    it("accepts FIAT_AMOUNT '999999.99' (large valid amount)", function () {
        expect(fiatErrors('999999.99')).to.have.length(0);
    });

    // <= 2 decimals mirrors the indexer's isValidFiatFormat(2, ...): one-
    // decimal and integer forms are consensus-valid, so the SDK accepts them.
    it("accepts FIAT_AMOUNT '1.0' (one decimal place, indexer parity)", function () {
        expect(fiatErrors('1.0')).to.have.length(0);
    });

    it("accepts FIAT_AMOUNT '1' (no decimal places, indexer parity)", function () {
        expect(fiatErrors('1')).to.have.length(0);
    });

    it("rejects FIAT_AMOUNT '1.000' (three decimal places)", function () {
        let errs = fiatErrors('1.000');
        expect(errs).to.have.length.greaterThan(0);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
    });

});
