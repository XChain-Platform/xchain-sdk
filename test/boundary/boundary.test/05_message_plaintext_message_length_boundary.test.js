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

// MESSAGE length boundary (3 tests)

describe('MESSAGE (PLAINTEXT_MESSAGE) length boundary', function () {

    let validator;
    // 1 MiB = 1,048,576 characters
    const MAX_LEN = 1048576;

    before(function () {
        validator = createValidator();
    });

    it('accepts PLAINTEXT_MESSAGE of exactly 1,048,576 characters (1 MiB limit)', function () {
        let msg = 'M'.repeat(MAX_LEN);
        let errors = validator.validate('MESSAGE', { DESTINATION: DEST_42, PLAINTEXT_MESSAGE: msg });
        let msgErrors = errors.filter(function (e) { return e.details && e.details.field === 'PLAINTEXT_MESSAGE'; });
        expect(msgErrors).to.have.length(0);
    });

    it('rejects PLAINTEXT_MESSAGE of exactly 1,048,577 characters (one above limit)', function () {
        let msg = 'M'.repeat(MAX_LEN + 1);
        let errors = validator.validate('MESSAGE', { DESTINATION: DEST_42, PLAINTEXT_MESSAGE: msg });
        let msgErrors = errors.filter(function (e) { return e.details && e.details.field === 'PLAINTEXT_MESSAGE'; });
        expect(msgErrors).to.have.length.greaterThan(0);
        expect(msgErrors[0].code).to.equal('INVALID_FIELD_VALUE');
    });

    it('accepts PLAINTEXT_MESSAGE of exactly 1,048,575 characters (one below limit)', function () {
        let msg = 'M'.repeat(MAX_LEN - 1);
        let errors = validator.validate('MESSAGE', { DESTINATION: DEST_42, PLAINTEXT_MESSAGE: msg });
        let msgErrors = errors.filter(function (e) { return e.details && e.details.field === 'PLAINTEXT_MESSAGE'; });
        expect(msgErrors).to.have.length(0);
    });

});
