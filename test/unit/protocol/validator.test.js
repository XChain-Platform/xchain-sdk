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
 * XChain Platform SDK - Validator Tests
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../src/utils/utility.js');
const Validator  = require('../../../src/protocol/validator.js');
const { SDKValidationError } = require('../../../src/utils/errors.js');

function createValidator() {
    return new Validator(new Utility());
}

// Helper: assert no errors of a given code in the result set
function hasNoErrorCode(errors, code) {
    return !errors.some(e => e.code === code);
}

// Helper: assert at least one error with given code
function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}

// TICK NAME VALIDATION

describe('Validator: TICK name validation (ISSUE action)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // Valid names
    it('accepts an all-uppercase TICK', function () {
        const errors = v.validate('ISSUE', { TICK: 'MYTOKEN' });
        expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('accepts a mixed-case alphanumeric TICK', function () {
        const errors = v.validate('ISSUE', { TICK: 'token123' });
        expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('accepts a single-character TICK', function () {
        const errors = v.validate('ISSUE', { TICK: 'A' });
        expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('accepts a TICK with an underscore', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN_TEST' });
        expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('accepts a TICK at the maximum length (250 chars)', function () {
        const name   = 'A'.repeat(250);
        const errors = v.validate('ISSUE', { TICK: name });
        expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    // Invalid names
    it('rejects an empty TICK', function () {
        const errors = v.validate('ISSUE', { TICK: '' });
        // Empty TICK triggers MISSING_REQUIRED_FIELD (field is treated as absent)
        expect(errors.length).to.be.greaterThan(0);
    });

});

describe('Validator: TICK name validation (ISSUE action)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


    it('rejects a TICK that exceeds 250 characters', function () {
        const name   = 'A'.repeat(251);
        const errors = v.validate('ISSUE', { TICK: name });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('rejects a TICK containing a pipe character', function () {
        const errors = v.validate('ISSUE', { TICK: 'BAD|TOKEN' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('rejects a TICK containing a semicolon', function () {
        const errors = v.validate('ISSUE', { TICK: 'BAD;TOKEN' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('accepts a TICK containing a dot (sub-token parent/child separator)', function () {
        const errors = v.validate('ISSUE', { TICK: 'PARENT.CHILD' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.false;
    });

    it('rejects a TICK with an empty dot segment (leading, trailing, consecutive)', function () {
        for (const tick of ['.LEAD', 'TRAIL.', 'A..B']) {
            const errors = v.validate('ISSUE', { TICK: tick });
            expect(hasErrorCode(errors, 'INVALID_TICK_NAME'), 'tick: ' + tick).to.be.true;
        }
    });

    it('rejects a TICK containing a slash', function () {
        const errors = v.validate('ISSUE', { TICK: 'BAD/TOKEN' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });
});

describe('Validator: TICK name validation (ISSUE action)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });



    // A caret-led ISSUE TICK is an id reference, not a name: it is refused as a bad
    // ID (xchain-indexer src/actions/issue.js:349, `invalid: TICK (id)`) rather than
    // as a bad name. The full per-format contract is test/unit/issue_tick_ref.test.js.
    it('rejects a TICK that starts with a caret and a non-numeric id', function () {
        const errors = v.validate('ISSUE', { TICK: '^BADSTART' });
        expect(hasErrorCode(errors, 'INVALID_TICK_ID')).to.be.true;
    });

    // Pins the SDK half of the indexer's `invalid: TICK (caret dot)` rejection
    // (xchain-indexer src/actions/issue.js:361, gated on BATCH_ISSUANCE_LIMITS). The
    // chain's own numeric guard is parseFloat-based, so a caret tail carrying a
    // '.' reads as a number and slips into a valid ISSUE with a NULL ticker id.
    // This rule is mirrored DIRECTLY (a blanket refusal of every caret-led ISSUE
    // TICK would be stricter than consensus), and these shapes are the assertion
    // for it. See the 2026-09-12 (P17) entry in src/preflight/INDEXER-MAP.md.
    it('rejects a caret ISSUE TICK whose tail contains a dot, the shape parseFloat lets through', function () {
        for (const tick of ['^12.5', '^1.0', '^0.1']) {
            const errors = v.validate('ISSUE', { TICK: tick });
            expect(hasErrorCode(errors, 'INVALID_TICK_ID'), 'tick: ' + tick).to.be.true;
        }
    });

});

describe('Validator: TICK name validation (ISSUE action)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


    it('rejects a TICK containing a backslash', function () {
        const errors = v.validate('ISSUE', { TICK: 'BAD\\TOKEN' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    // Cross-service guard: the SDK must never be more permissive than the
    // indexer's consensus TICK_CHARACTERS (xchain-indexer src/config.js). The
    // special-character set below is a verbatim copy of that consensus set;
    // if config.js changes, this literal (and TICK_REGEX) must change with it.
    // A user who clears the SDK pre-flight must always pass consensus, or they
    // sign+broadcast+pay for a transaction consensus then rejects.
    it('accepts exactly the indexer consensus special-character set (no more, no less)', function () {
        const CONSENSUS_TICK_SPECIALS = '~!@#$%^&*()_+-={}[]:<>.?'; // xchain-indexer/src/config.js TICK_CHARACTERS
        for (const ch of CONSENSUS_TICK_SPECIALS) {
            if (ch === '.') continue; // dot is the sub-token separator, covered by its own cases
            const tick = 'A' + ch + 'B'; // avoid the caret-first-char rule
            const errors = v.validate('ISSUE', { TICK: tick });
            expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME'), 'consensus char rejected: ' + ch).to.be.true;
        }
        // Characters the indexer set excludes must also fail the SDK pre-flight.
        for (const ch of ['\\', '|', ';', '/', ' ', '\t', 'é', '€']) {
            const errors = v.validate('ISSUE', { TICK: 'A' + ch + 'B' });
            expect(hasErrorCode(errors, 'INVALID_TICK_NAME'), 'non-consensus char accepted: ' + JSON.stringify(ch)).to.be.true;
        }
    });

    // TICK validation only applies to ISSUE; SEND just needs non-empty
    it('does NOT apply ISSUE tick-name rules when action is SEND', function () {
        // A dot in TICK is forbidden for ISSUE but irrelevant for SEND
        const errors = v.validate('SEND', {
            TICK:        'MY.TOKEN',
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
        });
        expect(hasNoErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });
});

// MEMO / DESCRIPTION VALIDATION

describe('Validator: MEMO validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a normal MEMO string', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            MEMO:        'normal memo'
        });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('accepts a MEMO with numbers', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            MEMO:        'with numbers 123'
        });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a MEMO containing a pipe character', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            MEMO:        'bad|memo'
        });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a MEMO containing a semicolon', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            MEMO:        'bad;memo'
        });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });
});

describe('Validator: DESCRIPTION validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a DESCRIPTION under 250 characters', function () {
        const errors = v.validate('ISSUE', {
            TICK:        'MYTOKEN',
            DESCRIPTION: 'A short description'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a DESCRIPTION containing a pipe', function () {
        const errors = v.validate('ISSUE', {
            TICK:        'MYTOKEN',
            DESCRIPTION: 'bad|desc'
        });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a DESCRIPTION over 250 characters', function () {
        const errors = v.validate('ISSUE', {
            TICK:        'MYTOKEN',
            DESCRIPTION: 'A'.repeat(251)
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// DECIMALS VALIDATION

describe('Validator: DECIMALS validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    [0, 1, 8, 18].forEach(function (val) {
        it('accepts DECIMALS = ' + val, function () {
            const errors = v.validate('ISSUE', { TICK: 'TOKEN', DECIMALS: val });
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });
    });

    it('rejects DECIMALS = 19 (exceeds maximum)', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', DECIMALS: 19 });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects DECIMALS = -1 (below minimum)', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', DECIMALS: -1 });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects non-numeric DECIMALS', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', DECIMALS: 'abc' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// MAX_SUPPLY VALIDATION

describe('Validator: MAX_SUPPLY validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a valid MAX_SUPPLY', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '21000000' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative MAX_SUPPLY', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '-1' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // The bound was applied to split('.')[0], and BigInt('-0') is 0n, so
    // every negative whose integer part is zero cleared the nonnegative check and was
    // serialized into an ISSUE the indexer refuses outright (its amount-format check
    // rejects a leading '-'), spending the fee for a guaranteed-invalid transaction.
    //
    // Asserting the BOUND message specifically, not merely the shared
    // INVALID_FIELD_VALUE code: the fractional-precision check in this same block
    // rejects most of these values too, so a code-only assertion would stay green with
    // the sign check deleted and prove nothing about it.
    const boundsErrors = (errors) =>
        errors.filter(e => e.code === 'INVALID_FIELD_VALUE' && /must be between 0 and/.test(e.message));

    ['-0.5', '-0.0001', '-0.9', '-0', ' -0.5', -0.5].forEach((neg) => {
        it(`rejects a negative fractional MAX_SUPPLY ${JSON.stringify(neg)} on the SIGN, not the precision`, function () {
            const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: neg, DECIMALS: 8 });
            expect(boundsErrors(errors)).to.have.lengthOf(1);
        });
    });

    it('leaves a legal positive fractional MAX_SUPPLY accepted (sign fix changes negatives only)', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '21000000.5', DECIMALS: 8 });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

});
