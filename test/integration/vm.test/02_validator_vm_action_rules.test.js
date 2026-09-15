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
 * XChain Platform SDK - VM Integration Tests
 *
 * Comprehensive tests for VM action support: DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW actions, contract utilities, contract client, format
 * selection, validation, batch integration, and explorer methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility   = require('../../../src/utils/utility.js');
const Validator = require('../../../src/protocol/validator.js');

// Validator – VM action rules

describe('Validator – VM action rules', function () {

    let validator;
    beforeEach(function () { validator = new Validator(new Utility()); });

    it('validates valid DEPLOY fields', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'aabbccdd',
            GAS_LIMIT: 100000
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('rejects DEPLOY with non-base64 CODE_ENCODING', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: '@@@',   // outside the base64 alphabet
            GAS_LIMIT: 100000
        });
        expect(errors.some(e => e.code === 'INVALID_FIELD_VALUE' && e.details.field === 'CODE_ENCODING')).to.be.true;
    });

    it('rejects DEPLOY with zero GAS_LIMIT', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'aabb',
            GAS_LIMIT: 0
        });
        expect(errors.some(e => e.details.field === 'GAS_LIMIT')).to.be.true;
    });

    it('validates valid EXECUTE fields', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: 'swap'
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('rejects EXECUTE with empty METHOD', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: ''
        });
        expect(errors.length).to.be.greaterThan(0);
    });

    it('rejects EXECUTE with METHOD containing pipe', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 123,
            METHOD: 'bad|method'
        });
        expect(errors.some(e => e.code === 'FORBIDDEN_CHARACTER')).to.be.true;
    });
});

describe('Validator – VM action rules', function () {

    let validator;
    beforeEach(function () { validator = new Validator(new Utility()); });

    it('validates valid DEPOSIT fields', function () {
        let errors = validator.validate('DEPOSIT', {
            CONTRACT_ACTION_INDEX: 42,
            TICK: 'TOKEN',
            QUANTITY: 1000
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('rejects DEPOSIT with non-positive QUANTITY', function () {
        let errors = validator.validate('DEPOSIT', {
            CONTRACT_ACTION_INDEX: 42,
            TICK: 'TOKEN',
            QUANTITY: 0
        });
        expect(errors.some(e => e.details.field === 'QUANTITY')).to.be.true;
    });

    it('validates valid WITHDRAW fields', function () {
        let errors = validator.validate('WITHDRAW', {
            CONTRACT_ACTION_INDEX: 42,
            TICK: 'TOKEN',
            QUANTITY: 500
        });
        expect(errors).to.have.lengthOf(0);
    });

    it('validates EXECUTE params array with forbidden chars', function () {
        let errors = validator.validate('EXECUTE', {
            CONTRACT_ACTION_INDEX: 1,
            METHOD: 'test',
            PARAMS: ['valid', 'in|valid']
        });
        expect(errors.some(e => e.code === 'INVALID_PARAM_VALUE')).to.be.true;
    });

    it('validates CONSTRUCTOR_PARAMS with forbidden chars', function () {
        let errors = validator.validate('DEPLOY', {
            CODE_ENCODING: 'aabb',
            GAS_LIMIT: 100000,
            CONSTRUCTOR_PARAMS: ['valid', 'in;valid']
        });
        expect(errors.some(e => e.code === 'INVALID_PARAM_VALUE')).to.be.true;
    });
});

describe('Validator – VM action rules', function () {

    let validator;
    beforeEach(function () { validator = new Validator(new Utility()); });

    it('BATCH rejects DEPLOY', function () {
        let errors = validator.validate('BATCH', {
            COMMAND: 'DEPLOY|0|aabb|100000'
        });
        expect(errors.some(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('DEPLOY'))).to.be.true;
    });

    it('BATCH allows EXECUTE', function () {
        let errors = validator.validate('BATCH', {
            COMMAND: 'EXECUTE|0|123|swap;SEND|0|TOKEN|100|addr1'
        });
        let deployErrors = errors.filter(e => e.code === 'BATCH_CONSTRAINT' && e.message.includes('EXECUTE'));
        expect(deployErrors).to.have.lengthOf(0);
    });
});
