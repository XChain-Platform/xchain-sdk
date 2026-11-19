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
const config = require('../../../src/config.js');
const Actions = require('../../../src/actions/index.js');
const Utility = require('../../../src/utils/utility.js');
const Validator = require('../../../src/protocol/validator.js');

function createValidator() {
    return new Validator(new Utility());
}

// DECIMALS boundary (8 tests)

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

    for (const value of [true, false]) {
        it('rejects boolean DECIMALS = ' + value, function () {
            const errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: value });
            const decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
            expect(decErrors).to.have.length.greaterThan(0);
            expect(decErrors[0].code).to.equal('INVALID_FIELD_VALUE');
        });
    }

    it('accepts a numeric DECIMALS string', function () {
        const errors = validator.validate('ISSUE', { TICK: 'TEST', DECIMALS: '8' });
        const decErrors = errors.filter(function (e) { return e.details && e.details.field === 'DECIMALS'; });
        expect(decErrors).to.have.length(0);
    });

    it('rejects boolean DECIMALS before composing ISSUE wire values', function () {
        const actions = new Actions({ config: config.getConfig(), util: new Utility(), options: { network: 'bitcoin-regtest' } });
        for (const DECIMALS of [true, false]) {
            expect(() => actions.composeActionString({ action: 'ISSUE', params: { TICK: 'TEST', DECIMALS } }))
                .to.throw().with.property('code', 'INVALID_FIELD_VALUE');
        }
    });

});
