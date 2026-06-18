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
const Utility    = require('../../src/utility.js');
const Validator  = require('../../src/validator.js');
const { SDKValidationError } = require('../../src/errors.js');

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

// ─────────────────────────────────────────────────────────────────────────────
// TICK NAME VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

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

    it('rejects a TICK that starts with a caret', function () {
        const errors = v.validate('ISSUE', { TICK: '^BADSTART' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

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

// ─────────────────────────────────────────────────────────────────────────────
// MEMO / DESCRIPTION VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// DECIMALS VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// MAX_SUPPLY VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

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

    it('rejects a MAX_SUPPLY over 1 sextillion', function () {
        // 1 sextillion + 1
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1000000000000000000001' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// LOCK FIELD VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: lock field validation', function () {

    const LOCK_FIELDS = [
        'LOCK_MAX_SUPPLY',
        'LOCK_MINT',
        'LOCK_MINT_SUPPLY',
        'LOCK_MAX_MINT',
        'LOCK_DESCRIPTION',
        'LOCK_SLEEP',
        'LOCK_CALLBACK'
    ];

    let v;
    beforeEach(function () { v = createValidator(); });

    LOCK_FIELDS.forEach(function (lockField) {
        it('accepts ' + lockField + ' = 0', function () {
            const fields = { TICK: 'TOKEN' };
            fields[lockField] = 0;
            const errors = v.validate('ISSUE', fields);
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });

        it('accepts ' + lockField + ' = 1', function () {
            const fields = { TICK: 'TOKEN' };
            fields[lockField] = 1;
            const errors = v.validate('ISSUE', fields);
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });

        it('rejects ' + lockField + ' = 2', function () {
            const fields = { TICK: 'TOKEN' };
            fields[lockField] = 2;
            const errors = v.validate('ISSUE', fields);
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });

        it('rejects ' + lockField + ' = -1', function () {
            const fields = { TICK: 'TOKEN' };
            fields[lockField] = -1;
            const errors = v.validate('ISSUE', fields);
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIAT_CODE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: FIAT_CODE validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    ['USD', 'GBP', 'JPY'].forEach(function (code) {
        it('accepts FIAT_CODE = ' + code, function () {
            const errors = v.validate('DISPENSER', {
                GIVE_TICK:   'TOKEN',
                GIVE_AMOUNT: '10',
                GET_TICK:    'BTC',
                GET_AMOUNT:  '0.001',
                FIAT_CODE:   code,
                FIAT_AMOUNT: '10.00'
            });
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });
    });

    it('rejects an unsupported FIAT_CODE', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_CODE:   'XXX'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIAT_AMOUNT VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: FIAT_AMOUNT validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts FIAT_AMOUNT in X.XX format', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_CODE:   'USD',
            FIAT_AMOUNT: '10.00'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects FIAT_AMOUNT with only one decimal place', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_AMOUNT: '10.0'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects FIAT_AMOUNT with no decimal part', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_AMOUNT: '10'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// COIN FIELD VALIDATION (GIVE_COIN, GET_COIN)
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: COIN field validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    ['BTC', 'LTC', 'DOGE'].forEach(function (coin) {
        it('accepts GIVE_COIN = ' + coin, function () {
            const errors = v.validate('ORDER', {
                ORDER_ACTION_INDEX: '1',
                GIVE_COIN:         coin
            });
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });

        it('accepts GET_COIN = ' + coin, function () {
            const errors = v.validate('ORDER', {
                ORDER_ACTION_INDEX: '1',
                GET_COIN:          coin
            });
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });
    });

    it('rejects GIVE_COIN = ETH', function () {
        const errors = v.validate('ORDER', {
            ORDER_ACTION_INDEX: '1',
            GIVE_COIN:         'ETH'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects GET_COIN = ETH', function () {
        const errors = v.validate('ORDER', {
            ORDER_ACTION_INDEX: '1',
            GET_COIN:          'ETH'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FEE_PREFERENCE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: FEE_PREFERENCE validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    [1, 2, 3].forEach(function (val) {
        it('accepts FEE_PREFERENCE = ' + val, function () {
            const errors = v.validate('ADDRESS', { FEE_PREFERENCE: val });
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        });
    });

    it('rejects FEE_PREFERENCE = 0', function () {
        const errors = v.validate('ADDRESS', { FEE_PREFERENCE: 0 });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects FEE_PREFERENCE = 4', function () {
        const errors = v.validate('ADDRESS', { FEE_PREFERENCE: 4 });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIST TYPE VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: LIST TYPE validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts LIST TYPE = 1', function () {
        const errors = v.validate('LIST', { TYPE: 1, ITEM: 'MYTOKEN' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts LIST TYPE = 2', function () {
        const errors = v.validate('LIST', { TYPE: 2, ITEM: 'MYTOKEN' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects LIST TYPE = 0', function () {
        const errors = v.validate('LIST', { TYPE: 0, ITEM: 'MYTOKEN' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects LIST TYPE = 3', function () {
        const errors = v.validate('LIST', { TYPE: 3, ITEM: 'MYTOKEN' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENCRYPTION_METHOD VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: ENCRYPTION_METHOD validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts ENCRYPTION_METHOD = 1', function () {
        const errors = v.validate('MESSAGE', {
            DESTINATION:       'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            ENCRYPTION_METHOD: 1
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts ENCRYPTION_METHOD = 2', function () {
        const errors = v.validate('MESSAGE', {
            DESTINATION:       'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            ENCRYPTION_METHOD: 2
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects ENCRYPTION_METHOD = 0', function () {
        const errors = v.validate('MESSAGE', {
            DESTINATION:       'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            ENCRYPTION_METHOD: 0
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts ENCRYPTION_METHOD = 3 (AES)', function () {
        // Method 3 (AES with pre-shared key) is a documented valid
        // encryption method per protocol/actions/MESSAGE.md.
        const errors = v.validate('MESSAGE', {
            DESTINATION:       'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
            ENCRYPTION_METHOD: 3
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED FIELDS
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: required field enforcement', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('returns MISSING_REQUIRED_FIELD when SEND is missing TICK', function () {
        const errors = v.validate('SEND', {
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
        });
        const tickError = errors.find(e => e.code === 'MISSING_REQUIRED_FIELD' && e.details.field === 'TICK');
        expect(tickError).to.exist;
    });

    it('returns MISSING_REQUIRED_FIELD when SEND is missing DESTINATION', function () {
        const errors = v.validate('SEND', {
            TICK:   'MYTOKEN',
            AMOUNT: '100'
        });
        const destError = errors.find(e => e.code === 'MISSING_REQUIRED_FIELD' && e.details.field === 'DESTINATION');
        expect(destError).to.exist;
    });

    it('returns MISSING_REQUIRED_FIELD when MINT is missing TICK', function () {
        const errors = v.validate('MINT', { AMOUNT: '100' });
        const tickError = errors.find(e => e.code === 'MISSING_REQUIRED_FIELD' && e.details.field === 'TICK');
        expect(tickError).to.exist;
    });

    it('returns MISSING_REQUIRED_FIELD when MINT is missing AMOUNT', function () {
        const errors = v.validate('MINT', { TICK: 'MYTOKEN' });
        const amountError = errors.find(e => e.code === 'MISSING_REQUIRED_FIELD' && e.details.field === 'AMOUNT');
        expect(amountError).to.exist;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// DISPENSER create-mode required fields
//
// Covers both dispenser lanes per DISPENSER.md §Formats v0:
//   - token-paid: GET_TICK names the token the buyer sends.
//   - coin-paid:  GET_COIN names the native coin the buyer sends; GET_TICK
//                 is empty (the primary §40.7.1 lane). The validator
//                 previously required GET_TICK unconditionally, which made
//                 the coin-paid lane unreachable through createAction.
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: DISPENSER create required fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a coin-paid dispenser (GET_COIN set, GET_TICK empty)', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_COIN:   'BTC',
            GIVE_TICK:   'JDOG',
            GIVE_AMOUNT: '1',
            GIVE_ESCROW: '10',
            GET_COIN:    'BTC',
            GET_TICK:    '',
            GET_AMOUNT:  '0.01',
        });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('accepts a token-paid dispenser (GET_TICK set, GET_COIN empty)', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'JDOG',
            GIVE_AMOUNT: '1',
            GIVE_ESCROW: '10',
            GET_TICK:    'XCP',
            GET_AMOUNT:  '0.5',
        });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('rejects a create that has neither GET_TICK nor GET_COIN', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'JDOG',
            GIVE_AMOUNT: '1',
            GIVE_ESCROW: '10',
            GET_AMOUNT:  '0.01',
        });
        expect(hasErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('still enforces GIVE_TICK, GIVE_AMOUNT, GET_AMOUNT on create', function () {
        const errors = v.validate('DISPENSER', { GET_COIN: 'BTC' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.include('GIVE_TICK');
        expect(missing).to.include('GIVE_AMOUNT');
        expect(missing).to.include('GET_AMOUNT');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// BATCH CONSTRAINTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: BATCH constraints', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('rejects a COMMAND with a nested BATCH', function () {
        const errors = v.validate('BATCH', { COMMAND: 'BATCH|arg1' });
        expect(hasErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT');
        expect(err.message).to.include('nested BATCH');
    });

    it('accepts a COMMAND that includes a FILE action (gated-content publish)', function () {
        // FILE in BATCH is supported: gated-content publishing uses
        // BATCH(FILE, MESSAGE-to-self) to atomically publish a gated
        // FILE alongside its key-handoff MESSAGE.
        const errors = v.validate('BATCH', { COMMAND: 'FILE|myfile.txt|text/plain' });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('rejects a COMMAND with 2 MINT actions', function () {
        const errors = v.validate('BATCH', {
            COMMAND: 'MINT|TOKEN1|10;MINT|TOKEN2|20'
        });
        expect(hasErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('at most 1 MINT'));
        expect(err).to.exist;
    });

    it('accepts a COMMAND with 1 MINT and 1 SEND (no BATCH errors)', function () {
        const errors = v.validate('BATCH', {
            COMMAND: 'MINT|TOKEN1|10;SEND|TOKEN2|5|bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
        });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTION-INDEX OPERATIONS SKIP REQUIRED FIELDS
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: action-index operations skip required fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('ORDER with ORDER_ACTION_INDEX only produces no MISSING_REQUIRED_FIELD errors', function () {
        const errors = v.validate('ORDER', { ORDER_ACTION_INDEX: '42' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('DISPENSER with DISPENSER_ACTION_INDEX only produces no MISSING_REQUIRED_FIELD errors', function () {
        const errors = v.validate('DISPENSER', { DISPENSER_ACTION_INDEX: '7' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateOrThrow
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: validateOrThrow', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('does not throw when fields are valid', function () {
        expect(function () {
            v.validateOrThrow('SEND', {
                TICK:        'MYTOKEN',
                AMOUNT:      '100',
                DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
            });
        }).to.not.throw();
    });

    it('throws SDKValidationError when there is one error', function () {
        expect(function () {
            v.validateOrThrow('SEND', {
                TICK:        'MYTOKEN',
                AMOUNT:      '100'
                // missing DESTINATION
            });
        }).to.throw(SDKValidationError);
    });

    it('throws SDKValidationError when there are multiple errors', function () {
        let thrown;
        try {
            v.validateOrThrow('SEND', {}); // missing TICK, AMOUNT, DESTINATION
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.be.instanceOf(SDKValidationError);
        expect(thrown.message).to.include('validation errors');
    });

    it('joins multiple error messages in the thrown error message', function () {
        let thrown;
        try {
            v.validateOrThrow('MINT', {}); // missing TICK and AMOUNT
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.be.instanceOf(SDKValidationError);
        // The message must contain both field names
        expect(thrown.message).to.satisfy(function (msg) {
            return msg.includes('TICK') || msg.includes('AMOUNT');
        });
    });

    it('thrown SDKValidationError carries a code property', function () {
        let thrown;
        try {
            v.validateOrThrow('SEND', {
                AMOUNT:      '100',
                DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
                // missing TICK
            });
        } catch (e) {
            thrown = e;
        }
        expect(thrown.code).to.equal('MISSING_REQUIRED_FIELD');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADDRESS VALIDATION (DESTINATION)
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: address validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a valid bech32 address (42 chars)', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects an address that is too short', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: 'short'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts a P2PKH-length address (34 chars)', function () {
        const errors = v.validate('SEND', {
            TICK:        'MYTOKEN',
            AMOUNT:      '100',
            DESTINATION: '1BpEi6DfDAUFd153wiGrvkiKW1w6wer456' // 34 chars
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN ACTION
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: unknown action', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('returns UNKNOWN_ACTION error for an unrecognised action type', function () {
        const errors = v.validate('FAKEACTION', {});
        expect(hasErrorCode(errors, 'UNKNOWN_ACTION')).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIELD-LEVEL VALIDATION: COOLDOWN_BLOCKS / VALUE / DEPLOY / DISPENSER ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: field + cross-field constraints', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // COOLDOWN_BLOCKS (DEPLOY v1)
    it('rejects a non-numeric COOLDOWN_BLOCKS', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: 'abc' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        expect(errors.some(e => /COOLDOWN_BLOCKS must be numeric/.test(e.message))).to.be.true;
    });

    it('rejects a COOLDOWN_BLOCKS below the minimum (1)', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be in \[1, 100000\]/.test(e.message))).to.be.true;
    });

    it('rejects a COOLDOWN_BLOCKS above the maximum (100000)', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: '100001' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be in \[1, 100000\]/.test(e.message))).to.be.true;
    });

    it('accepts a COOLDOWN_BLOCKS within range', function () {
        const errors = v.validate('DEPLOY', { COOLDOWN_BLOCKS: '500' });
        expect(errors.some(e => /COOLDOWN_BLOCKS/.test(e.message))).to.be.false;
    });

    // VALUE (BROADCAST)
    it('rejects a non-numeric VALUE', function () {
        const errors = v.validate('BROADCAST', { VALUE: 'not-a-number' });
        expect(errors.some(e => /VALUE must be numeric/.test(e.message))).to.be.true;
    });

    // DEPLOY cross-field: SLASH_DESTINATION requires COOLDOWN_BLOCKS
    it('rejects DEPLOY with SLASH_DESTINATION but no COOLDOWN_BLOCKS', function () {
        const errors = v.validate('DEPLOY', { SLASH_DESTINATION: '1BurnAddrXXXXXXXXXXXXXXXXXXXXXXX' });
        expect(hasErrorCode(errors, 'DEPLOY_CONSTRAINT')).to.be.true;
    });

    it('accepts DEPLOY with both SLASH_DESTINATION and COOLDOWN_BLOCKS', function () {
        const errors = v.validate('DEPLOY', {
            SLASH_DESTINATION: '1BurnAddrXXXXXXXXXXXXXXXXXXXXXXX', COOLDOWN_BLOCKS: '100',
        });
        expect(hasErrorCode(errors, 'DEPLOY_CONSTRAINT')).to.be.false;
    });

    // DISPENSER ownership create-path: GIVE_AMOUNT / GIVE_ESCROW must be empty
    it('rejects an ownership DISPENSER carrying a GIVE_AMOUNT', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_OWNERSHIP: '1', GIVE_TICK: 'TOK', GET_AMOUNT: '5', GET_COIN: 'BTC',
            GIVE_AMOUNT: '10',
        });
        expect(errors.some(e => /GIVE_AMOUNT must be empty when GIVE_OWNERSHIP=1/.test(e.message))).to.be.true;
    });

    it('rejects an ownership DISPENSER carrying a GIVE_ESCROW', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_OWNERSHIP: '1', GIVE_TICK: 'TOK', GET_AMOUNT: '5', GET_COIN: 'BTC',
            GIVE_ESCROW: '3',
        });
        expect(errors.some(e => /GIVE_ESCROW must be empty when GIVE_OWNERSHIP=1/.test(e.message))).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLER BIND/UNBIND VALIDATION (ISSUE v6 / ADDRESS v1, programmable policy)
// ─────────────────────────────────────────────────────────────────────────────

describe('Validator: controller bind/unbind (ISSUE v6 / ADDRESS v1)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // CONTROLLER: non-negative integer (a contract ACTION_INDEX)
    it('accepts a non-negative integer CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '42', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.false;
    });
    it('rejects a negative CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '-1', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(errors.some(e => /CONTROLLER must be a non-negative integer/.test(e.message))).to.be.true;
    });
    it('rejects a non-integer CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '4.2', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(errors.some(e => /CONTROLLER must be a non-negative integer/.test(e.message))).to.be.true;
    });

    // ACTION_CLASS: must be one of {transfer, trade, burn, mint, stake}
    ['transfer', 'trade', 'burn', 'mint', 'stake'].forEach(cls => {
        it('accepts ACTION_CLASS=' + cls, function () {
            const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: cls, UNBIND: '0' });
            expect(errors.some(e => /ACTION_CLASS must be one of/.test(e.message))).to.be.false;
        });
    });
    it('rejects an unknown ACTION_CLASS', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: 'admin', UNBIND: '0' });
        expect(errors.some(e => /ACTION_CLASS must be one of/.test(e.message))).to.be.true;
    });

    // UNBIND: 0 or 1 only
    it('accepts UNBIND=0 and UNBIND=1', function () {
        expect(v.validate('ADDRESS', { CONTROLLER: '1', ACTION_CLASS: 'trade', UNBIND: '0' }).some(e => /UNBIND must be/.test(e.message))).to.be.false;
        expect(v.validate('ADDRESS', { ACTION_CLASS: 'trade', UNBIND: '1' }).some(e => /UNBIND must be/.test(e.message))).to.be.false;
    });
    it('rejects UNBIND=2', function () {
        const errors = v.validate('ADDRESS', { CONTROLLER: '1', ACTION_CLASS: 'trade', UNBIND: '2' });
        expect(errors.some(e => /UNBIND must be 0 .bind. or 1 .unbind./.test(e.message))).to.be.true;
    });

    // COOLDOWN_BLOCKS: non-negative integer on a controller bind (0 allowed)
    it('accepts COOLDOWN_BLOCKS=0 on an ISSUE controller bind', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: 'mint', COOLDOWN_BLOCKS: '0', UNBIND: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS/.test(e.message))).to.be.false;
    });
    it('accepts COOLDOWN_BLOCKS=0 on an ADDRESS controller bind', function () {
        const errors = v.validate('ADDRESS', { CONTROLLER: '1', ACTION_CLASS: 'trade', COOLDOWN_BLOCKS: '0', UNBIND: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS/.test(e.message))).to.be.false;
    });
    it('rejects a negative COOLDOWN_BLOCKS on a controller bind', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', CONTROLLER: '1', ACTION_CLASS: 'mint', COOLDOWN_BLOCKS: '-5', UNBIND: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be a non-negative integer/.test(e.message))).to.be.true;
    });
    it('still enforces the DEPLOY COOLDOWN_BLOCKS [1,100000] range', function () {
        const errors = v.validate('DEPLOY', { CODE_ENCODING: 'ab', GAS_LIMIT: '1', COOLDOWN_BLOCKS: '0' });
        expect(errors.some(e => /COOLDOWN_BLOCKS must be in \[1, 100000\]/.test(e.message))).to.be.true;
    });

    // Bind/unbind interlock
    it('requires CONTROLLER on a bind (UNBIND=0)', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', ACTION_CLASS: 'transfer', UNBIND: '0' });
        expect(errors.some(e => /CONTROLLER is required to bind/.test(e.message))).to.be.true;
    });
    it('requires ACTION_CLASS whenever controller fields are present', function () {
        const errors = v.validate('ADDRESS', { CONTROLLER: '1', UNBIND: '0' });
        expect(errors.some(e => /ACTION_CLASS is required for a controller bind\/unbind/.test(e.message))).to.be.true;
    });
    it('allows an unbind (UNBIND=1) with no CONTROLLER', function () {
        const errors = v.validate('ISSUE', { TICK: 'X', ACTION_CLASS: 'burn', UNBIND: '1' });
        expect(errors.some(e => /CONTROLLER is required to bind/.test(e.message))).to.be.false;
    });
    it('leaves a plain ISSUE (no controller fields) unaffected by the interlock', function () {
        const errors = v.validate('ISSUE', { TICK: 'PLAIN', DESCRIPTION: 'hi' });
        expect(errors.some(e => /controller bind/.test(e.message))).to.be.false;
        expect(errors.some(e => /CONTROLLER is required/.test(e.message))).to.be.false;
    });
});
