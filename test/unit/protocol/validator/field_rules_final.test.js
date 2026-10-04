// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const { FIELD_VALIDATORS } = require('../../../../src/protocol/validator/field_rules_final.js');
const { VALID_COINS } = require('../../../../src/protocol/validator/field_limits.js');

function makeValidator(isNumeric = () => true) {
    return {
        buildError: (code, message, details) => ({ code, message, details }),
        util: { isNumeric }
    };
}

function validate(rule, { validator = makeValidator(), action = 'ISSUE', field, value }) {
    const errors = [];
    rule(validator, action, field, value, {}, errors);
    return errors;
}

describe('final field validators', function () {

    it('exports four validators in rule order', function () {
        expect(FIELD_VALIDATORS).to.have.length(4);
    });

    it('accepts the bridge sentinel and every valid coin', function () {
        const rule = FIELD_VALIDATORS[0];
        expect(validate(rule, { field: 'BRIDGE_CHAINS', value: '-' })).to.deep.equal([]);
        expect(validate(rule, { field: 'BRIDGE_CHAINS', value: VALID_COINS.join(',') })).to.deep.equal([]);
    });

    it('reports only the first invalid bridge coin', function () {
        const errors = validate(FIELD_VALIDATORS[0], { field: 'BRIDGE_CHAINS', value: 'BTC,XXX' });
        expect(errors).to.have.length(1);
        expect(errors[0]).to.include({ code: 'INVALID_FIELD_VALUE' });
        expect(errors[0].details.value).to.equal('XXX');
    });

    it('ignores bridge values on another field', function () {
        expect(validate(FIELD_VALIDATORS[0], { field: 'COIN', value: 'BTC,XXX' })).to.deep.equal([]);
    });

    it('accepts a whole-number minimum depth', function () {
        expect(validate(FIELD_VALIDATORS[1], { field: 'MIN_DEPTH', value: '12' })).to.deep.equal([]);
    });

    for (const value of ['1.5', '-1', '']) {
        it(`rejects minimum depth ${JSON.stringify(value)}`, function () {
            const errors = validate(FIELD_VALIDATORS[1], { field: 'MIN_DEPTH', value });
            expect(errors).to.have.length(1);
            expect(errors[0]).to.include({ code: 'INVALID_FIELD_VALUE' });
        });
    }

    it('uses the validator numeric predicate for VALUE', function () {
        const validator = makeValidator(() => false);
        const errors = validate(FIELD_VALIDATORS[2], { validator, field: 'VALUE', value: '12' });
        expect(errors).to.have.length(1);
        expect(errors[0]).to.include({ code: 'INVALID_FIELD_VALUE', message: 'VALUE must be numeric' });
    });

    for (const value of ['1', '0.5']) {
        it(`accepts PRICE VALUE ${value}`, function () {
            expect(validate(FIELD_VALIDATORS[3], { action: 'PRICE', field: 'VALUE', value })).to.deep.equal([]);
        });
    }

    for (const value of ['0', '-1', 'abc', '1.123456789']) {
        it(`rejects PRICE VALUE ${value}`, function () {
            const errors = validate(FIELD_VALIDATORS[3], { action: 'PRICE', field: 'VALUE', value });
            expect(errors).to.have.length(1);
            expect(errors[0]).to.include({ code: 'INVALID_FIELD_VALUE' });
        });
    }

    it('ignores VALUE for actions other than PRICE', function () {
        expect(validate(FIELD_VALIDATORS[3], { action: 'SEND', field: 'VALUE', value: '0' })).to.deep.equal([]);
    });

});
