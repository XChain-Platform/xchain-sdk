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

    it('rejects a MAX_SUPPLY over 1 sextillion', function () {
        // 1 sextillion + 1
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1000000000000000000001' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // Fractional precision. The ceiling check reads split('.')[0] only, so an
    // over-precise MAX_SUPPLY cleared the SDK and was then refused on-chain as
    // 'invalid: MAX_SUPPLY (format)' with the miner fee already paid. What the OFFLINE
    // validator may assert about it is bounded by what it can know: the indexer measures
    // the fraction against the TOKEN ROW's decimals (issue.js:258) and only falls back to
    // the wire DECIMALS when the row has none, so the wire value is not the tick's on a
    // re-issue. The row-aware check is in preflight/checks/issue.js.
    it('rejects a MAX_SUPPLY with more fractional digits than any tick can carry', function () {
        // 19 fractional digits; MAX_DECIMALS is 18, so this is invalid at every decimals.
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1.1234567890123456789', DECIMALS: 8 });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts a MAX_SUPPLY at exactly MAX_DECIMALS fractional digits', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1.123456789012345678', DECIMALS: 18 });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts a whole MAX_SUPPLY with DECIMALS 0', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '21000000', DECIMALS: 0 });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // Never stricter than consensus, the re-issue case. An 8-decimal token re-issued with a
    // stale wire DECIMALS=0 is ACCEPTED on-chain (tick_decimals comes from the row), so an
    // offline reject keyed to the wire value would block a legal action.
    it('does not reject a fractional MAX_SUPPLY carrying a stale wire DECIMALS', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1000.5', DECIMALS: 0 });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // Same rule with DECIMALS absent: the indexer resolves NaN decimals and caps nothing,
    // so the SDK must not invent a 0.
    it('does not reject a fractional MAX_SUPPLY when DECIMALS is absent', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1.5' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('does not cap the fraction at all when DECIMALS is absent', function () {
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1.1234567890123456789' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// LOCK FIELD VALIDATION

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

// FIAT_CODE VALIDATION

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

// FIAT_AMOUNT VALIDATION

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

    // The rule mirrors the indexer's isValidFiatFormat(2,...): at most 2
    // decimals, not exactly 2. One-decimal and integer forms are consensus-
    // valid (and are what a numeric round-trip produces for "10.50"/"10.00"),
    // so the SDK must accept them too.
    it('accepts FIAT_AMOUNT with only one decimal place (indexer parity)', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_AMOUNT: '10.0'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts FIAT_AMOUNT with no decimal part (indexer parity)', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_AMOUNT: '10'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects FIAT_AMOUNT with three decimal places', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_AMOUNT: '1.999'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative FIAT_AMOUNT', function () {
        const errors = v.validate('DISPENSER', {
            GIVE_TICK:   'TOKEN',
            GIVE_AMOUNT: '10',
            GET_TICK:    'BTC',
            GET_AMOUNT:  '0.001',
            FIAT_AMOUNT: '-1.00'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// FIAT DISPENSER GET_AMOUNT = 0
//
// A fiat-priced dispenser does not store a coin price. It is derived at
// SETTLEMENT from FIAT_AMOUNT and the validator price snapshot, so GET_AMOUNT is
// 0 by protocol convention (DISPENSER.md examples 4/5; xchain-indexer
// dispense.js names it outright - "the GET_AMOUNT of 0 that FIAT dispensers
// carry by convention"). The indexer validates only GET_AMOUNT's FORMAT for a
// DISPENSER and never its sign.
//
// The positive-amount rule used to apply to GET_AMOUNT unconditionally, which
// made this SDK strictly stricter than the chain and had a total effect:
// NEITHER fiat pricing mode could be composed, so the whole fiat/oracle
// dispenser feature was unreachable through any client using this validator.
// Found by the wallet's fiat dispenser e2e lane, which could not get past the
// form.

describe('Validator: FIAT dispenser GET_AMOUNT convention', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const BASE = { GIVE_TICK: 'TOKEN', GIVE_AMOUNT: '10', GIVE_ESCROW: '100', GET_COIN: 'BTC' };

    it('accepts GET_AMOUNT 0 on a validator-priced FIAT dispenser', function () {
        const errors = v.validate('DISPENSER', {
            ...BASE, GET_AMOUNT: '0', FIAT_CODE: 'USD', FIAT_AMOUNT: '3.00'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts GET_AMOUNT 0 on a user-oracle dispenser, where FIAT_AMOUNT is ignored', function () {
        const errors = v.validate('DISPENSER', {
            ...BASE,
            GET_AMOUNT:     '0',
            FIAT_CODE:      'JPY',
            ORACLE_ADDRESS: 'bc1qmr46t4ca5wh35k6mczdzrkepqw2d8ne9ryqz4c'
        });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // The exemption has to be NARROW or it becomes a hole: an ordinary
    // coin-priced dispenser with a zero price would dispense for nothing.
    it('still rejects GET_AMOUNT 0 on a dispenser with no fiat pricing at all', function () {
        const errors = v.validate('DISPENSER', { ...BASE, GET_AMOUNT: '0' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('still rejects a NEGATIVE GET_AMOUNT even on a FIAT dispenser', function () {
        const errors = v.validate('DISPENSER', {
            ...BASE, GET_AMOUNT: '-1', FIAT_CODE: 'USD', FIAT_AMOUNT: '3.00'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('still rejects a zero GIVE_AMOUNT on a FIAT dispenser: only the PRICE is derived', function () {
        const errors = v.validate('DISPENSER', {
            ...BASE, GIVE_AMOUNT: '0', GET_AMOUNT: '0', FIAT_CODE: 'USD', FIAT_AMOUNT: '3.00'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('does not leak the exemption to another action carrying GET_AMOUNT', function () {
        // ORDER and SWAP both have GET_AMOUNT and neither has a fiat lane, so
        // the FIAT_CODE guard must be action-scoped rather than field-scoped.
        const errors = v.validate('ORDER', {
            GIVE_TICK: 'TOKEN', GIVE_AMOUNT: '10', GET_COIN: 'BTC', GET_AMOUNT: '0',
            FIAT_CODE: 'USD'
        });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// PRICE v1 ORACLE PUBLISH (FIAT / VALUE / FEE)
//
// The user-run token oracle (PC-30). Its fiat field is named FIAT, not
// FIAT_CODE, so it missed the allow-list check entirely until this suite;
// VALUE fell through to BROADCAST's numeric-only rule and FEE was checked
// for BROADCAST only. Each case below mirrors an indexer verdict in
// xchain-indexer/src/actions/price.js _parseV1.

describe('Validator: PRICE v1 oracle publish', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    function pub(over) {
        return Object.assign({ COIN: 'BTC', TICK: 'PEPECASH', FIAT: 'USD', VALUE: '0.05' }, over);
    }

    it('accepts a well-formed publish', function () {
        const errors = v.validate('PRICE', pub());
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects an unsupported FIAT', function () {
        const errors = v.validate('PRICE', pub({ FIAT: 'XXX' }));
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts every supported FIAT code', function () {
        Validator.VALID_FIAT_CODES.forEach((code) => {
            const errors = v.validate('PRICE', pub({ FIAT: code }));
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE'), code).to.be.true;
        });
    });

    it('rejects a zero VALUE (a zero price is not a price)', function () {
        const errors = v.validate('PRICE', pub({ VALUE: '0' }));
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative VALUE', function () {
        const errors = v.validate('PRICE', pub({ VALUE: '-1' }));
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a VALUE with more than 8 decimal places', function () {
        const errors = v.validate('PRICE', pub({ VALUE: '0.123456789' }));
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts a VALUE at exactly 8 decimal places', function () {
        const errors = v.validate('PRICE', pub({ VALUE: '0.00000001' }));
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts an omitted FEE (the field is optional)', function () {
        const errors = v.validate('PRICE', pub());
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts a FEE inside [0, 1]', function () {
        ['0', '0.01', '1'].forEach((fee) => {
            const errors = v.validate('PRICE', pub({ FEE: fee }));
            expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE'), fee).to.be.true;
        });
    });

    it('rejects a FEE above 1 (a fee, not a percentage)', function () {
        const errors = v.validate('PRICE', pub({ FEE: '1.5' }));
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative FEE', function () {
        const errors = v.validate('PRICE', pub({ FEE: '-0.01' }));
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // BROADCAST shares both field names and must keep its looser rules: its
    // VALUE is an arbitrary numeric datum and its FEE is a percentage.
    it('leaves BROADCAST VALUE and FEE on their own looser rules', function () {
        const errors = v.validate('BROADCAST', { MESSAGE: 'hello', VALUE: '0.123456789', FEE: '5' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// COIN FIELD VALIDATION (GIVE_COIN, GET_COIN)

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

// FEE_PREFERENCE VALIDATION

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

// LIST TYPE VALIDATION

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

// FREE-TEXT DELIMITER GUARDS (FILE NAME/TYPE/TITLE, LIST ITEM)
//
// These fields are serialized verbatim into the pipe-delimited action string.
// An unescaped '|' corrupts the field layout; an unescaped ';' inside a BATCH
// injects a whole extra command (the indexer splits BATCH TX_DATA on ';'), so
// they must be rejected client-side exactly like MEMO/DESCRIPTION/TICK.

describe('Validator: FILE free-text delimiter guards', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a normal FILE (name/type/title)', function () {
        const errors = v.validate('FILE', { NAME: 'readme.txt', TYPE: 'text/plain', TITLE: 'My File' });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in FILE NAME', function () {
        const errors = v.validate('FILE', { NAME: 'evil|X', TYPE: 'text/plain', TITLE: 'ok' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in FILE TYPE', function () {
        const errors = v.validate('FILE', { NAME: 'f', TYPE: 'text|plain', TITLE: 'ok' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a semicolon in FILE TITLE (BATCH command injection)', function () {
        const errors = v.validate('FILE', { NAME: 'f', TYPE: 'text/plain', TITLE: 'ok;SEND|0|^1|9|addr' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });
});

describe('Validator: LIST ITEM delimiter guards', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts delimiter-clean ITEM entries', function () {
        const errors = v.validate('LIST', { TYPE: 1, ITEM: ['FOO', 'BAR'] });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in a LIST ITEM entry', function () {
        const errors = v.validate('LIST', { TYPE: 1, ITEM: ['GOOD', 'BAD|X'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a semicolon in a LIST ITEM entry (BATCH command injection)', function () {
        const errors = v.validate('LIST', { TYPE: 2, ITEM: ['addr;MINT|0|FOO|1'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in a single (non-array) LIST ITEM value', function () {
        const errors = v.validate('LIST', { TYPE: 1, ITEM: 'BAD|X' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });
});

describe('Validator: VOTE free-text delimiter guards', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a clean VOTE poll', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no', QUESTION: 'Adopt?' });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in OPTIONS (field-layout corruption)', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no|EVIL' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a semicolon in OPTIONS (BATCH command injection)', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no;MINT|0|X|1' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in QUESTION', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no', QUESTION: 'a|b' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in a cast BALLOT', function () {
        const errors = v.validate('VOTE', { VERSION: 1, POLL_REF: '5', BALLOT: '0|9' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });
});

describe('Validator: allow/block-list delimiter guards', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a clean ISSUE allow-list', function () {
        const errors = v.validate('ISSUE', { VERSION: 0, TICK: 'FOO', MAX_SUPPLY: '100', ALLOW_LIST: ['addrA', 'addrB'] });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in a string ALLOW_LIST', function () {
        const errors = v.validate('ISSUE', { VERSION: 0, TICK: 'FOO', MAX_SUPPLY: '100', ALLOW_LIST: 'x|y' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in an array ALLOW_LIST entry', function () {
        const errors = v.validate('ISSUE', { VERSION: 0, TICK: 'FOO', MAX_SUPPLY: '100', ALLOW_LIST: ['good', 'ba|d'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a semicolon in a BLOCK_LIST entry', function () {
        const errors = v.validate('ISSUE', { VERSION: 0, TICK: 'FOO', MAX_SUPPLY: '100', BLOCK_LIST: ['addr;SEND|0|x'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });
});

describe('Validator: default-deny delimiter guard', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    // The guard is default-deny: a field with NO field-specific validation still
    // cannot smuggle a delimiter. GAS_ESCROW/CALLBACK_CONTRACT had no validation
    // of their own before the blanket guard.
    it('rejects a pipe in a field that has no field-specific validation (GAS_ESCROW)', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'y,n', GAS_ESCROW: '5|9' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in CALLBACK_CONTRACT (previously unguarded)', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'y,n', CALLBACK_CONTRACT: '7|X' });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    // BATCH COMMAND is the one field that legitimately carries both delimiters
    // (it IS the ';'-joined, '|'-delimited sub-action string). It must NOT trip
    // the guard.
    it('exempts BATCH COMMAND (legitimately holds ; and |)', function () {
        const errors = v.validate('BATCH', { VERSION: 0, COMMAND: 'SEND|0|FOO|1|addr;MINT|0|FOO|1' });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    // Exempt fields keep their own distinct-code delimiter rejection (no
    // double-reporting): TICK -> INVALID_TICK_NAME, CONSTRUCTOR_PARAMS -> INVALID_PARAM_VALUE.
    it('a pipe in TICK still reports INVALID_TICK_NAME, not the generic guard', function () {
        const errors = v.validate('ISSUE', { VERSION: 0, TICK: 'FO|O', MAX_SUPPLY: '100' });
        expect(hasErrorCode(errors, 'INVALID_TICK_NAME')).to.be.true;
    });

    it('a pipe in a CONSTRUCTOR_PARAMS entry still reports INVALID_PARAM_VALUE', function () {
        const errors = v.validate('DEPLOY', { VERSION: 1, GAS_LIMIT: '100', CODE_ENCODING: 'abc', CONSTRUCTOR_PARAMS: ['ok', 'ba|d'] });
        expect(hasErrorCode(errors, 'INVALID_PARAM_VALUE')).to.be.true;
    });
});

describe('Validator: VOTE binding-poll numeric fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const base = { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no' };

    it('accepts a binding poll with valid DEPOSIT / CALLBACK_CONTRACT / GAS_ESCROW', function () {
        const errors = v.validate('VOTE', { ...base, DEPOSIT: '10', CALLBACK_CONTRACT: '7', CALLBACK_METHOD: 'onResult', GAS_ESCROW: '5' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('accepts CALLBACK_CONTRACT 0 (contract ACTION_INDEXes start at 0)', function () {
        const errors = v.validate('VOTE', { ...base, CALLBACK_CONTRACT: '0', CALLBACK_METHOD: 'onResult' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a non-numeric DEPOSIT', function () {
        const errors = v.validate('VOTE', { ...base, DEPOSIT: 'lots' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative DEPOSIT', function () {
        const errors = v.validate('VOTE', { ...base, DEPOSIT: '-1' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative GAS_ESCROW', function () {
        const errors = v.validate('VOTE', { ...base, CALLBACK_CONTRACT: '7', CALLBACK_METHOD: 'onResult', GAS_ESCROW: '-5' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a non-numeric GAS_ESCROW', function () {
        const errors = v.validate('VOTE', { ...base, CALLBACK_CONTRACT: '7', CALLBACK_METHOD: 'onResult', GAS_ESCROW: 'plenty' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a non-integer CALLBACK_CONTRACT', function () {
        const errors = v.validate('VOTE', { ...base, CALLBACK_CONTRACT: '7.5', CALLBACK_METHOD: 'onResult' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a negative CALLBACK_CONTRACT', function () {
        const errors = v.validate('VOTE', { ...base, CALLBACK_CONTRACT: '-3', CALLBACK_METHOD: 'onResult' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    it('rejects a non-numeric CALLBACK_CONTRACT', function () {
        const errors = v.validate('VOTE', { ...base, CALLBACK_CONTRACT: 'seven', CALLBACK_METHOD: 'onResult' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// VOTE PER-VERSION REQUIRED FIELDS
// VOTE's anchors are version-split, so they live in _validateVote rather than in
// the flat ACTION_REQUIRED_FIELDS table. Field lists track vote.md's Formats section.

describe('Validator: VOTE per-version required fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a complete v0 create poll', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('rejects a v0 create poll missing END_BLOCK and OPTIONS', function () {
        const errors = v.validate('VOTE', { VERSION: 0, TICK: 'GOV' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.have.members(['END_BLOCK', 'OPTIONS']);
    });

    it('accepts a complete v1 ballot', function () {
        const errors = v.validate('VOTE', { VERSION: 1, POLL_REF: '307', BALLOT: '1' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    // The reported defect: a hand-rolled v1 carrying only POLL_REF passed the SDK
    // and serialized, then died at the indexer on 'invalid: BALLOT (empty)'.
    it('rejects a v1 ballot carrying only POLL_REF', function () {
        const errors = v.validate('VOTE', { VERSION: 1, POLL_REF: '307' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['BALLOT']);
    });

    it('rejects a v1 ballot carrying only BALLOT', function () {
        const errors = v.validate('VOTE', { VERSION: 1, BALLOT: '1' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['POLL_REF']);
    });

    it('rejects the system-only v2 finalizer', function () {
        const errors = v.validate('VOTE', { VERSION: 2, POLL_REF: '307' });
        expect(hasErrorCode(errors, 'VOTE_CONSTRAINT')).to.be.true;
    });

    it('accepts a v3 delegation set', function () {
        const errors = v.validate('VOTE', { VERSION: 3, TICK: 'GOV', DELEGATE_TO: 'mAlice' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    // vote.md:52 - a blank DELEGATE_TO is the documented clear-delegation action, so
    // requiring DELEGATE_TO would reject a legitimate broadcast.
    it('accepts a v3 clear-delegation with a blank DELEGATE_TO', function () {
        const errors = v.validate('VOTE', { VERSION: 3, TICK: 'GOV', DELEGATE_TO: '' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('rejects a v3 delegation missing TICK', function () {
        const errors = v.validate('VOTE', { VERSION: 3, DELEGATE_TO: 'mAlice' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['TICK']);
    });

    // With no VERSION the format is auto-selected downstream, so the anchor is the
    // field that discriminates: POLL_REF exists only in v1, DELEGATE_TO only in v3.
    it('rejects a version-less POLL_REF-only call', function () {
        const errors = v.validate('VOTE', { POLL_REF: '307' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['BALLOT']);
    });

    it('rejects a version-less DELEGATE_TO-only call', function () {
        const errors = v.validate('VOTE', { DELEGATE_TO: 'mAlice' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['TICK']);
    });

    // A payload carrying NEITHER discriminator is still auto-selected, not refused:
    // the selector sorts fitting formats by length and v1 is the shortest, so these
    // two used to serialize a bare `VOTE|1` the indexer refuses.
    it('rejects a wholly empty VOTE instead of serializing VOTE|1', function () {
        const errors = v.validate('VOTE', {});
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['POLL_REF', 'BALLOT']);
    });

    it('rejects a MEMO-only VOTE, which also auto-selects the ballot format', function () {
        const errors = v.validate('VOTE', { MEMO: 'note' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['POLL_REF', 'BALLOT']);
    });

    // TICK alone auto-selects v3 (shorter than v0), where a blank DELEGATE_TO is the
    // documented clear-delegation, so it is a complete command and must NOT be flagged.
    it('accepts a version-less TICK-only call as a clear-delegation', function () {
        const errors = v.validate('VOTE', { TICK: 'GOV' });
        expect(errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD')).to.deep.equal([]);
    });

    // A v0-only field pins the create-poll format, so the v0 anchors are demanded.
    it('rejects a version-less END_BLOCK-only call against the v0 anchors', function () {
        const errors = v.validate('VOTE', { END_BLOCK: '900000' });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);
        expect(missing).to.deep.equal(['TICK', 'OPTIONS']);
    });
});

// DELEGATE PER-VERSION REQUIRED FIELDS
// DELEGATE carried an empty ACTION_REQUIRED_FIELDS entry, so sdk.delegate({}) built
// and paid for `DELEGATE|0` that the indexer refuses as SIGNING_PUBKEY (required).
// The flat table cannot express these: the rotate flavors carry NEW_SIGNING_PUBKEY
// and the revoke flavors SIGNING_PUBKEY, with no field common to all four.

describe('Validator: DELEGATE per-version required fields', function () {

    const PUB = 'a'.repeat(64);
    let v;
    beforeEach(function () { v = createValidator(); });

    const missingOf = (errors) =>
        errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD').map(e => e.details.field);

    it('rejects a wholly empty DELEGATE instead of serializing DELEGATE|0', function () {
        expect(missingOf(v.validate('DELEGATE', {}))).to.deep.equal(['NEW_SIGNING_PUBKEY']);
    });

    it('accepts a complete v0 capability rotate', function () {
        const errors = v.validate('DELEGATE', { VERSION: 0, NEW_SIGNING_PUBKEY: PUB });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('rejects a v1 contract-targeted rotate missing TARGET_CONTRACT_INDEX and TICK', function () {
        const errors = v.validate('DELEGATE', { VERSION: 1, NEW_SIGNING_PUBKEY: PUB });
        expect(missingOf(errors)).to.have.members(['TARGET_CONTRACT_INDEX', 'TICK']);
    });

    it('accepts a complete v1 contract-targeted rotate', function () {
        const errors = v.validate('DELEGATE', { VERSION: 1, NEW_SIGNING_PUBKEY: PUB, TARGET_CONTRACT_INDEX: '42', TICK: 'TOK' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('rejects a v2 capability revoke with no SIGNING_PUBKEY', function () {
        expect(missingOf(v.validate('DELEGATE', { VERSION: 2 }))).to.deep.equal(['SIGNING_PUBKEY']);
    });

    it('accepts a complete v3 contract-targeted revoke', function () {
        const errors = v.validate('DELEGATE', { VERSION: 3, SIGNING_PUBKEY: PUB, TARGET_CONTRACT_INDEX: '42', TICK: 'TOK' });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('rejects a v3 contract-targeted revoke missing TICK', function () {
        const errors = v.validate('DELEGATE', { VERSION: 3, SIGNING_PUBKEY: PUB, TARGET_CONTRACT_INDEX: '42' });
        expect(missingOf(errors)).to.deep.equal(['TICK']);
    });

    // With VERSION absent the format is auto-selected downstream, so the wire field
    // discriminates: SIGNING_PUBKEY means revoke, TARGET_CONTRACT_INDEX/TICK mean
    // the contract-targeted pair.
    it('reads a version-less SIGNING_PUBKEY call as a revoke and accepts it', function () {
        const errors = v.validate('DELEGATE', { SIGNING_PUBKEY: PUB });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });

    it('reads a version-less TICK-only call as contract-targeted and names what is missing', function () {
        const errors = v.validate('DELEGATE', { TICK: 'TOK' });
        expect(missingOf(errors)).to.have.members(['NEW_SIGNING_PUBKEY', 'TARGET_CONTRACT_INDEX']);
    });

    it('accepts the version-less rotate the golden fixture builds', function () {
        const errors = v.validate('DELEGATE', { NEW_SIGNING_PUBKEY: PUB });
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
    });
});

// ENCRYPTION_METHOD VALIDATION

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

// REQUIRED FIELDS

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

// DISPENSER create-mode required fields
//
// Covers both dispenser lanes per DISPENSER.md §Formats v0:
//   - token-paid: GET_TICK names the token the buyer sends.
//   - coin-paid:  GET_COIN names the native coin the buyer sends; GET_TICK
//                 is empty (the primary §40.7.1 lane). The validator
//                 previously required GET_TICK unconditionally, which made
//                 the coin-paid lane unreachable through createAction.

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

// BATCH CONSTRAINTS

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

// ACTION-INDEX OPERATIONS SKIP REQUIRED FIELDS

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

// validateOrThrow

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

// ADDRESS VALIDATION (DESTINATION)

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

// UNKNOWN ACTION

describe('Validator: unknown action', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('returns UNKNOWN_ACTION error for an unrecognised action type', function () {
        const errors = v.validate('FAKEACTION', {});
        expect(hasErrorCode(errors, 'UNKNOWN_ACTION')).to.be.true;
    });
});

// FIELD-LEVEL VALIDATION: COOLDOWN_BLOCKS / VALUE / DEPLOY / DISPENSER ownership

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

// CONTROLLER BIND/UNBIND VALIDATION (ISSUE v6 / ADDRESS v1, programmable policy)

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

// ADDRESS ^id REFERENCE VALIDATION (address compaction)

describe('Validator: address ^id reference', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a numeric ^id in DESTINATION (no crypto-address error)', function () {
        const errors = v.validate('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: '^57' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
        expect(hasNoErrorCode(errors, 'INVALID_ADDRESS_ID')).to.be.true;
    });

    it('accepts a numeric ^id in GET_ADDRESS', function () {
        const errors = v.validate('DISPENSER', { GIVE_TICK: 'JDOG', GIVE_QUANTITY: '1', ESCROW_QUANTITY: '1', MAINCHAINRATE: '1', GET_ADDRESS: '^900' });
        expect(hasNoErrorCode(errors, 'INVALID_ADDRESS_ID')).to.be.true;
    });

    it('rejects a non-numeric ^id with INVALID_ADDRESS_ID', function () {
        const errors = v.validate('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: '^notanumber' });
        expect(hasErrorCode(errors, 'INVALID_ADDRESS_ID')).to.be.true;
    });

    it('still rejects a malformed full address in DESTINATION', function () {
        const errors = v.validate('SEND', { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'not-an-address!!' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });
});

// PC-29: FILE.GATE_MIN_AMOUNT (the unlock threshold)
//
// A ninth, optional FILE field. Every rule here is a FORMAT rule and every one
// exists for a reason worth stating, because the value is consensus-visible and
// lands in a VARCHAR(40): a value this validator lets through must be one the
// indexer can store and compare without the DB changing it.
//
// Divisibility is deliberately absent. The real bound is
// min(gate tick divisibility, THRESHOLD_SCALE), and divisibility is chain STATE
// at the FILE's block, which a stateless validator does not have. The indexer is
// the arbiter for that half; a guess here would be a second, weaker opinion that
// disagrees at exactly the boundary the shared vectors exist to pin.

describe('Validator: FILE GATE_MIN_AMOUNT (PC-29)', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const bad = (value) => v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain', GATE_MIN_AMOUNT: value });
    const isRejected = (value) => !hasNoErrorCode(bad(value), 'INVALID_FIELD_VALUE');

    it('accepts an absent or empty threshold (= no threshold)', function () {
        expect(hasNoErrorCode(v.validate('FILE', { NAME: 'f.txt', TYPE: 'text/plain' }), 'INVALID_FIELD_VALUE')).to.be.true;
        expect(isRejected(''), 'empty means no threshold, not an invalid one').to.be.false;
    });

    it('accepts ordinary decimal amounts', function () {
        for (const ok of ['1', '100', '0.5', '0.00000001', '12345.6789', '1.0'])
            expect(isRejected(ok), ok).to.be.false;
    });

    it('rejects every spelling of zero', function () {
        // A zero threshold is not "no threshold"; it is a threshold nobody can fail.
        // Letting it through would give one meaning two encodings.
        for (const z of ['0', '0.0', '0.00000000'])
            expect(isRejected(z), z).to.be.true;
    });

    it('rejects signs and exponents', function () {
        for (const s of ['-1', '+1', '1e3', '1E3', '-0.5'])
            expect(isRejected(s), s).to.be.true;
    });

    it('rejects malformed decimal shapes', function () {
        for (const s of ['1.', '.5', '1.2.3', '1,5', '1 ', ' 1', 'abc', '1a'])
            expect(isRejected(s), JSON.stringify(s)).to.be.true;
    });

    it('rejects leading zeros so one value has exactly one spelling', function () {
        // '01' and '1' would otherwise be two byte-different FILEs meaning the same
        // threshold, which the shared P1/P9 vectors treat as a defect.
        for (const s of ['01', '007', '00.5'])
            expect(isRejected(s), s).to.be.true;
        expect(isRejected('0.5'), 'a single leading zero before the point is correct').to.be.false;
    });

    it('rejects a pipe, which would split the wire record', function () {
        expect(isRejected('1|2')).to.be.true;
    });

    it('enforces the 40-character bound the storage column depends on', function () {
        const forty = '1'.repeat(40);
        expect(isRejected(forty), '40 is allowed').to.be.false;
        expect(isRejected('1'.repeat(41)), '41 is not').to.be.true;
        // The bound is a WIRE rule, not merely a column width: if an oversized value
        // reached a VARCHAR(40) it could be silently truncated, and consensus validity
        // would then depend on the DB's mode rather than on the bytes.
        expect(isRejected('0.' + '1'.repeat(45))).to.be.true;
    });

    it('does NOT reject on divisibility, which is the indexer\'s call', function () {
        // 30 decimal places is beyond any tick's divisibility, but this validator is
        // stateless and must not pretend to know. It is a well-formed decimal, so it
        // passes here and the indexer rejects it against the gate tick at that block.
        expect(isRejected('0.' + '1'.repeat(30)), 'stateless layer must stay silent on divisibility').to.be.false;
    });

    it('applies only to FILE, not to other actions carrying a like-named field', function () {
        const errors = v.validate('SEND', { GATE_MIN_AMOUNT: '0' });
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // ── Shared vector fixture (spec section 6.5)
    // The tests above are this repo's own reading of the rules. These run the SAME
    // vectors the indexer and the wallet run, from a byte-identical file, so the
    // three implementations are pinned to one another rather than to three
    // independently-written test suites that agree today by coincidence.
    describe('shared GATE_MIN_AMOUNT vectors', function () {
        const fs      = require('fs');
        const path    = require('path');
        const FIXTURE = path.join(__dirname, '../fixtures/gate-min-amount-vectors.json');
        const vectors = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

        it('the fixture carries vectors in every section (it has not been emptied)', function () {
            for (const key of ['format', 'divisibility', 'pack_threshold', 'handoff_required'])
                expect(vectors[key], key).to.be.an('array').with.length.greaterThan(0);
        });

        for (const vec of vectors.format) {
            it(`${vec.label}: ${JSON.stringify(vec.value)} is ${vec.valid ? 'accepted' : 'rejected'}`, function () {
                expect(isRejected(vec.value)).to.equal(!vec.valid);
            });
        }

        // The asymmetry the shared fixture exposed: setActionParams trims every action
        // field on the indexer's way in, so a whitespace-padded threshold reaches
        // consensus already trimmed and is ACCEPTED there, while this layer refuses to
        // emit it. Pinned on both sides so the difference stays deliberate: closing it
        // would mean changing the trim for every field of every action.
        for (const vec of vectors.layer_asymmetry.sdk_rejects_indexer_normalizes) {
            it(`${vec.label}: ${JSON.stringify(vec.value)} is rejected here, normalized by the indexer`, function () {
                expect(isRejected(vec.value), 'the SDK must not emit it').to.be.true;
                expect(isRejected(vec.normalizes_to), 'the trimmed form is what consensus sees').to.be.false;
            });
        }

        // The division of labour, asserted rather than described: every divisibility
        // vector is a well-formed decimal, so this stateless layer must pass ALL of
        // them, including the ones the indexer rejects against the tick at that block.
        for (const vec of vectors.divisibility) {
            it(`divisibility is not this layer's call: ${vec.value} passes the format check`, function () {
                expect(isRejected(vec.value)).to.be.false;
            });
        }

        // Cross-repo byte identity. Skips (rather than fails) when a sibling checkout
        // is absent, matching the repo's other sibling-conformance tests; CI sets
        // XCHAIN_REQUIRE_SIBLINGS=1 so a missing sibling hard-fails there.
        const SIBLINGS = [
            ['xchain-indexer', 'test/fixtures/gate-min-amount-vectors.json'],
            ['xchain-wallet',  'test/fixtures/gate-min-amount-vectors.json']
        ];
        const canonical = fs.readFileSync(FIXTURE);
        SIBLINGS.forEach(([repo, rel]) => {
            it(`the ${repo} copy is byte-identical`, function () {
                const p = path.join(__dirname, '../../..', repo, rel);
                if (!fs.existsSync(p)) {
                    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                        throw new Error('sibling ' + repo + ' fixture missing: ' + p);
                    return this.skip();
                }
                expect(fs.readFileSync(p).equals(canonical),
                    repo + ' fixture drifted from the canonical sdk copy').to.be.true;
            });
        });
    });
});
