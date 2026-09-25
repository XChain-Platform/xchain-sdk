'use strict';

const { expect } = require('chai');
const Utility    = require('../../../src/utils/utility.js');
const Validator  = require('../../../src/protocol/validator.js');
const { MAX_BROADCAST_FEE_LENGTH } = require('../../../src/protocol/validator/field_limits.js');

describe('Validator: BROADCAST FEE length', function () {

    let v;
    beforeEach(function () { v = new Validator(new Utility()); });

    const validateFee = fee => v.validate('BROADCAST', { VERSION: 0, MESSAGE: 'hello', FEE: fee });
    const lengthErrors = fee => validateFee(fee)
        .filter(e => e.message === 'FEE must be 11 characters or less');

    it('exports the 11-character limit', function () {
        expect(MAX_BROADCAST_FEE_LENGTH).to.equal(11);
    });

    it('accepts an 11-character FEE', function () {
        const fee = '0.123456789';
        expect(fee).to.have.length(MAX_BROADCAST_FEE_LENGTH);
        expect(validateFee(fee)).to.deep.equal([]);
    });

    it('refuses a 12-character FEE with the length message', function () {
        const fee = '0.1234567890';
        expect(fee).to.have.length(MAX_BROADCAST_FEE_LENGTH + 1);
        const errs = lengthErrors(fee);
        expect(errs).to.have.length(1);
        expect(errs[0].code).to.equal('INVALID_FIELD_VALUE');
        expect(errs[0].details.constraint).to.deep.equal({ max: 11 });
    });
});
