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

function hasNoErrorCode(errors, code) {
    return !errors.some(e => e.code === code);
}

function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}



describe('Validator: MAX_SUPPLY validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const boundsErrors = (errors) =>
        errors.filter(e => e.code === 'INVALID_FIELD_VALUE' && /must be between 0 and/.test(e.message));


    it('rejects a MAX_SUPPLY over 1 sextillion', function () {
        // 1 sextillion + 1
        const errors = v.validate('ISSUE', { TICK: 'TOKEN', MAX_SUPPLY: '1000000000000000000001' });
        expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
    });

    // Fractional precision. The ceiling check reads split('.')[0] only, so an
    // over-precise MAX_SUPPLY cleared the SDK and was then refused on-chain as
    // 'invalid: MAX_SUPPLY (format)' with the miner fee already paid. What the OFFLINE
    // validator may assert about it is bounded by what it can know: the indexer measures
    // the fraction against the token record's decimals (issue.js:258) and only falls back to
    // the wire DECIMALS when the record has none, so the wire value is not the tick's on a
    // re-issue. The record-aware check is in preflight/checks/issue.js.
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
    // stale wire DECIMALS=0 is ACCEPTED on-chain (tick_decimals comes from the record), so an
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
        // LOCK_BRIDGE is the ISSUE v7 bridge opt-in's freeze over BRIDGE_CHAINS and
        // MIN_DEPTH. Listed by hand rather than read off config['LOCK_FIELDS'], so
        // dropping it from that list fails here instead of quietly testing nothing.
        'LOCK_CALLBACK',
        'LOCK_BRIDGE'
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

});

describe('Validator: FIAT_AMOUNT validation', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


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
// Applying the positive-amount rule to GET_AMOUNT unconditionally makes this
// SDK strictly stricter than the chain and has a total effect:
// NEITHER fiat pricing mode could be composed, so the whole fiat/oracle
// dispenser feature was unreachable through any client using this validator.
// Found by the wallet's fiat dispenser e2e run, which could not get past the
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
        // ORDER and SWAP both have GET_AMOUNT and neither has a fiat pricing mode, so
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
// xchain-indexer/src/actions/price/index.js parseV1.

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

});
