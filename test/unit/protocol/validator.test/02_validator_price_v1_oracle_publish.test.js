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
const Utility    = require('../../../../src/utils/utility.js');
const Validator  = require('../../../../src/protocol/validator.js');
const { SDKValidationError } = require('../../../../src/utils/errors.js');

function createValidator() {
    return new Validator(new Utility());
}

function hasNoErrorCode(errors, code) {
    return !errors.some(e => e.code === code);
}

function hasErrorCode(errors, code) {
    return errors.some(e => e.code === code);
}



describe('Validator: PRICE v1 oracle publish', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    function pub(over) {
        return Object.assign({ COIN: 'BTC', TICK: 'PEPECASH', FIAT: 'USD', VALUE: '0.05' }, over);
    }


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

    // The range gate must compare as an EXACT decimal, not as a JS double.
    // Number('1.000000000000000001') rounds to exactly 1, so a float compare
    // certified this value while the indexer's bcgt(V1_FEE,'1') rejects it, and
    // the signed, fee-paying action landed invalid on-chain.
    it('rejects a FEE just above 1 that IEEE-754 rounds to exactly 1', function () {
        ['1.000000000000000001', '1.00000000000000001'].forEach((fee) => {
            expect(Number(fee) > 1, fee + ' must be float-indistinguishable from 1').to.be.false;
            const errors = v.validate('PRICE', pub({ FEE: fee }));
            expect(hasErrorCode(errors, 'INVALID_FIELD_VALUE'), fee).to.be.true;
        });
    });

    it('still accepts a FEE just below 1 at full 18-decimal width', function () {
        const errors = v.validate('PRICE', pub({ FEE: '0.999999999999999999' }));
        expect(hasNoErrorCode(errors, 'INVALID_FIELD_VALUE')).to.be.true;
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

    // TYPE 2 is an ADDRESS list, so the item has to look like an address. A tick
    // such as 'MYTOKEN' only passes while the validator checks length alone; a
    // tick in an address list is exactly what the coin-aware check exists to
    // refuse.
    it('accepts LIST TYPE = 2', function () {
        const errors = v.validate('LIST', { TYPE: 2, ITEM: '16Jswqk47s9PUcyCc88MMVwzgvHPvtEpf' });
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

// LIST gained MEMO in place on v0/v1. It sits BEFORE the variadic ITEM tail
// (a trailing memo cannot be told apart from one more item), which makes its
// delimiter safety load-bearing in a way a trailing memo's is not: a pipe in
// the memo shifts every following segment, so the first item is read as a
// memo fragment and the list silently gains and loses members. The default-deny
// _checkDelimiters guard already covers every field, so these pin the coverage
// rather than add a rule.
describe('Validator: LIST MEMO delimiter guards', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    it('accepts a delimiter-clean MEMO', function () {
        const errors = v.validate('LIST', { TYPE: 1, MEMO: 'Our official tokens', ITEM: ['FOO'] });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a pipe in a LIST MEMO (would shift every following item)', function () {
        const errors = v.validate('LIST', { TYPE: 1, MEMO: 'a|b', ITEM: ['FOO'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('rejects a semicolon in a LIST MEMO (BATCH command injection)', function () {
        const errors = v.validate('LIST', { TYPE: 2, MEMO: 'x;MINT|0|FOO|1', ITEM: ['1ExampleAddressXXXXXXXXXXXXXXXXXXX'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('guards MEMO on the v1 edit format too', function () {
        const errors = v.validate('LIST', { EDIT: 1, LIST_ACTION_INDEX: '1234', MEMO: 'a|b', ITEM: ['FOO'] });
        expect(hasErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
    });

    it('treats an omitted MEMO as absent, not as an error', function () {
        const errors = v.validate('LIST', { TYPE: 1, ITEM: ['FOO'] });
        expect(hasNoErrorCode(errors, 'FORBIDDEN_CHARACTER')).to.be.true;
        expect(hasNoErrorCode(errors, 'MISSING_REQUIRED_FIELD')).to.be.true;
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
