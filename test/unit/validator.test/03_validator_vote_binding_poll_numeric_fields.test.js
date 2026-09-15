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
});

describe('Validator: VOTE per-version required fields', function () {

    let v;
    beforeEach(function () { v = createValidator(); });



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
    // these two serialize a bare `VOTE|1` that the indexer refuses without this guard.
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
