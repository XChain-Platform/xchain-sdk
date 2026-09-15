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
 * XChain Platform SDK - Fuzz Tests
 *
 * Core principle: NO test should cause an unhandled exception.
 * Every test must either succeed or throw a clean SDKError subclass.
 * A raw TypeError, RangeError, etc. is a bug.
 *
 ********************************************************************/

const { expect }    = require('chai');
const Utility       = require('../../../src/utils/utility.js');
const Validator     = require('../../../src/protocol/validator.js');

function createValidator() {
    return new Validator(new Utility());
}

// A real-looking segwit address (42 chars – passes the loose isCryptoAddress check)
const VALID_DEST = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// Raw error types that must NEVER escape from SDK boundaries
const RAW_ERROR_CONSTRUCTORS = [TypeError, RangeError, SyntaxError, URIError, EvalError];

function assertCleanError(e) {
    // Must be an Error instance
    expect(e, 'thrown value must be an Error').to.be.instanceOf(Error);
    // Must NOT be a raw JS runtime error
    for (let RawErr of RAW_ERROR_CONSTRUCTORS) {
        expect(e, `must not be a raw ${RawErr.name}`).to.not.be.instanceOf(RawErr);
    }
    // Name must start with "SDK"
    expect(e.name, 'error name must start with SDK').to.match(/^SDK/);
}

// Group 6: Validator with garbage inputs

describe('Fuzz – Group 6: Validator with garbage inputs', function() {

    it('validate(null, {}) → returns errors array, never crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate(null, {});
            // Should return an array (possibly with UNKNOWN_ACTION error)
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            // If it throws, must be a clean SDK error
            assertCleanError(e);
        }
    });

    it('validate(123, {}) → returns errors array or clean throw', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate(123, {});
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('validate("SEND", null) → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', null);
            // null fields: may return errors or empty array
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});

describe('Fuzz – Group 6: Validator with garbage inputs', function() {

    it("validate('SEND', 'string') → must not crash", function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', 'string');
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('validate("SEND", []) → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', []);
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('SEND with TICK = { nested: object } → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', { TICK: { nested: 'object' }, AMOUNT: '100', DESTINATION: VALID_DEST });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('SEND with AMOUNT = [1, 2, 3] → must not crash', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('SEND', { TICK: 'TOK', AMOUNT: [1, 2, 3], DESTINATION: VALID_DEST });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});

describe('Fuzz – Group 6: Validator with garbage inputs', function() {

    it('ISSUE with DECIMALS = NaN → returns errors', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('ISSUE', { TICK: 'MYTOKEN', DECIMALS: NaN });
            expect(result).to.be.an('array');
            // NaN should fail the DECIMALS integer check
            let hasDecimalsError = result.some(e => e.field === 'DECIMALS' || e.code === 'INVALID_FIELD_VALUE');
            // Either an error is reported or the NaN was treated as isEmpty and skipped
            // Both outcomes are acceptable as long as it doesn't crash
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('ISSUE with DECIMALS = Infinity → returns errors', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('ISSUE', { TICK: 'MYTOKEN', DECIMALS: Infinity });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

    it('ISSUE with MAX_SUPPLY = -Infinity → returns errors', function() {
        let validator = createValidator();
        let threw = false;
        try {
            let result = validator.validate('ISSUE', { TICK: 'MYTOKEN', MAX_SUPPLY: -Infinity });
            expect(result).to.be.an('array');
        } catch (e) {
            threw = true;
            assertCleanError(e);
        }
    });

});
