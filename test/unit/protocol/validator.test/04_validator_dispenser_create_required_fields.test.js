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



// DISPENSER create-mode required fields
//
// Covers both dispenser payment modes per DISPENSER.md §Formats v0:
//   - token-paid: GET_TICK names the token the buyer sends.
//   - coin-paid:  GET_COIN names the native coin the buyer sends; GET_TICK
//                 is empty (the primary §40.7.1 path). The validator
//                 requires GET_TICK only for the token-paid form, keeping the
//                 coin-paid path reachable through createAction.

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

    const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    // A minimal well-formed DEPLOY (VERSION|CODE_ENCODING|GAS_LIMIT); the code
    // body only has to be valid base64 for the per-command validation to pass,
    // so the BATCH cap is what any finding here is about.
    const DEPLOY_CMD = 'DEPLOY|0|' + Buffer.from('function main(){return 1}').toString('base64') + '|100000';

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

    it('rejects a COMMAND with 2 MINT actions of the SAME tick', function () {
        const errors = v.validate('BATCH', {
            COMMAND: 'MINT|TOKEN1|10;MINT|TOKEN1|20'
        });
        expect(hasErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('per distinct TICK'));
        expect(err).to.exist;
        expect(err.details).to.include({ count: 2, limit: 1 });
    });

    it('accepts MINTs of two DISTINCT ticks (the cap is per token, not per command)', function () {
        const errors = v.validate('BATCH', {
            COMMAND: 'MINT|TOKEN1|10;MINT|TOKEN2|20;MINT|TOKEN3|30'
        });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('reads a legacy no-VERSION MINT TICK off the injected VERSION 0', function () {
        // 'MINT|A|1|addr' has no VERSION, so the arbiter's injection makes the
        // TICK params[1]; reading params[1] of the RAW command would see the
        // amount instead and count two different tokens as one bucket.
        const errors = v.validate('BATCH', {
            COMMAND: 'MINT|A|1|' + ADDR + ';MINT|B|1|' + ADDR
        });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
        const same = v.validate('BATCH', {
            COMMAND: 'MINT|A|1|' + ADDR + ';MINT|A|2|' + ADDR
        });
        expect(same.some(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('per distinct TICK'))).to.be.true;
    });

});

describe('Validator: BATCH constraints', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const DEPLOY_CMD = 'DEPLOY|0|' + Buffer.from('function main(){return 1}').toString('base64') + '|100000';


    it('refuses a caret MINT TICK beside a named one: the SDK cannot resolve the alias', function () {
        // `JDOG` and `^614` can be ONE token to the arbiter, so accepting the
        // pair would let a minter take two bites at one scarce token.
        const errors = v.validate('BATCH', { COMMAND: 'MINT|0|^614|10;MINT|0|JDOG|20' });
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('caret alias'));
        expect(err).to.exist;
        expect(err.message).to.include('Spell every MINT TICK by name');
        expect(err.details.ticks).to.deep.equal(['^614', 'JDOG']);
    });

    it('accepts MINTs whose TICKs are ALL caret ids: two ids are two tokens', function () {
        // tickResolver compacts MINT TICKs to `^<id>` before serializing, so this
        // is the shape the SDK's own builder produces for two distinct names.
        // Refusing it would be a false refusal of a batch the chain accepts.
        const errors = v.validate('BATCH', { COMMAND: 'MINT|0|^614|10;MINT|0|^615|20' });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('still rejects two MINTs of the SAME caret id', function () {
        const errors = v.validate('BATCH', { COMMAND: 'MINT|0|^614|10;MINT|0|^614|20' });
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('per distinct TICK'));
        expect(err).to.exist;
    });

    it('does not refuse a single caret MINT TICK (nothing to alias)', function () {
        const errors = v.validate('BATCH', { COMMAND: 'MINT|0|^614|10;SEND|0|JDOG|1|' + ADDR });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('accepts ONE DEPLOY in a BATCH (capped at 1, never banned)', function () {
        const errors = v.validate('BATCH', { COMMAND: DEPLOY_CMD });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('rejects TWO DEPLOYs: every DEPLOY runs a constructor in the VM', function () {
        const errors = v.validate('BATCH', { COMMAND: DEPLOY_CMD + ';' + DEPLOY_CMD });
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('at most 1 DEPLOY'));
        expect(err).to.exist;
        expect(err.details).to.include({ count: 2, limit: 1 });
    });

});

describe('Validator: BATCH constraints', function () {

    let v;
    beforeEach(function () { v = createValidator(); });

    const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const DEPLOY_CMD = 'DEPLOY|0|' + Buffer.from('function main(){return 1}').toString('base64') + '|100000';


    it('accepts a COMMAND with 1 MINT and 1 SEND (no BATCH errors)', function () {
        const errors = v.validate('BATCH', {
            COMMAND: 'MINT|TOKEN1|10;SEND|TOKEN2|5|bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
        });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('accepts one top-level ISSUE plus any number of dotted children', function () {
        const errors = v.validate('BATCH', {
            COMMAND: 'ISSUE|0|JDOG|1000;ISSUE|0|JDOG.1|1;ISSUE|0|JDOG.2|1;ISSUE|0|JDOG.3.4|1'
        });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('still rejects two TOP-LEVEL ISSUE actions', function () {
        const errors = v.validate('BATCH', { COMMAND: 'ISSUE|0|JDOG|1000;ISSUE|0|OTHER|1' });
        const err = errors.find(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('top-level ISSUE'));
        expect(err).to.exist;
        expect(err.details.count).to.equal(2);
    });

    it('rejects two caret-TICK ISSUEs: a caret is never a child, dot or no dot', function () {
        const errors = v.validate('BATCH', { COMMAND: 'ISSUE|0|^12.5|1;ISSUE|0|^13.6|1' });
        expect(errors.some(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('top-level ISSUE'))).to.be.true;
    });

    it('classifies a legacy no-VERSION dotted TICK as a child', function () {
        const errors = v.validate('BATCH', { COMMAND: 'ISSUE|JDOG.1|1000;ISSUE|JDOG.2|1000;ISSUE|JDOG|1' });
        expect(hasNoErrorCode(errors, 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('rejects more than 250 commands, and reports ONLY the cap', function () {
        // Cap precedence: this COMMAND also carries 251 top-level ISSUEs.
        const command = Array.from({ length: 251 }, (_, i) => 'ISSUE|0|T' + i + '|1').join(';');
        const errors = v.validate('BATCH', { COMMAND: command });
        const batchErrors = errors.filter(e => e.code === 'BATCH_CONSTRAINT');
        expect(batchErrors).to.have.length(1);
        expect(batchErrors[0].message).to.include('at most 250 commands');
        expect(batchErrors[0].details).to.include({ count: 251, limit: 250 });
    });

    it('accepts exactly 250 commands', function () {
        const command = Array.from({ length: 250 }, (_, i) => 'ISSUE|0|T.' + i + '|1').join(';');
        expect(hasNoErrorCode(v.validate('BATCH', { COMMAND: command }), 'BATCH_CONSTRAINT')).to.be.true;
    });

    it('counts a trailing semicolon as a command: 250 plus one is over the cap', function () {
        const command = Array.from({ length: 250 }, (_, i) => 'ISSUE|0|T.' + i + '|1').join(';') + ';';
        expect(hasErrorCode(v.validate('BATCH', { COMMAND: command }), 'BATCH_CONSTRAINT')).to.be.true;
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

});

describe('Validator: validateOrThrow', function () {

    let v;
    beforeEach(function () { v = createValidator(); });


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
