// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const Utility = require('../../../../../src/utils/utility.js');
const Validator = require('../../../../../src/protocol/validator.js');

function fieldErrors(validator, action, fields, field) {
    return validator.validate(action, fields).filter((error) => error.details && error.details.field === field);
}

describe('Validator: FILE gate tick references', function () {
    const validator = new Validator(new Utility());

    it('accepts collection child ticks as FILE gates', function () {
        for (const tick of ['PEPESERIES', 'PEPESERIES.GENESIS', 'A.B.C', '']) {
            const errors = fieldErrors(validator, 'FILE', {
                NAME: 'f.txt', TYPE: 'text/plain', GATE_TICKER: tick,
            }, 'GATE_TICKER');
            expect(errors, tick).to.deep.equal([]);
        }
    });

    it('rejects wire delimiters, slashes, and empty child-tick segments', function () {
        for (const tick of ['A|B', 'A;B', 'A/B', '.X', 'X.', 'A..B']) {
            const errors = fieldErrors(validator, 'FILE', {
                NAME: 'f.txt', TYPE: 'text/plain', GATE_TICKER: tick,
            }, 'GATE_TICKER');
            expect(errors, tick).to.have.length(1);
            expect(errors[0].code).to.equal('INVALID_FIELD_VALUE');
        }
    });
});

describe('Validator: ownership flags', function () {
    const validator = new Validator(new Utility());

    it('rejects fractional ownership flags for every carrying action', function () {
        const cases = [
            ['ORDER', 'GIVE_OWNERSHIP'], ['ORDER', 'GET_OWNERSHIP'],
            ['SWAP', 'GIVE_OWNERSHIP'], ['SWAP', 'GET_OWNERSHIP'],
            ['DISPENSER', 'GIVE_OWNERSHIP'],
        ];
        for (const [action, field] of cases) {
            for (const value of ['1.9', '0.5']) {
                const errors = fieldErrors(validator, action, { [field]: value }, field);
                expect(errors, action + '.' + field + '=' + value).to.have.length(1);
                expect(errors[0].code).to.equal('INVALID_FIELD_VALUE');
            }
        }
    });

    it('accepts the ownership values the indexer converts to zero or one', function () {
        for (const value of ['0', '1', 0, 1]) {
            for (const action of ['ORDER', 'SWAP', 'DISPENSER']) {
                expect(fieldErrors(validator, action, { GIVE_OWNERSHIP: value }, 'GIVE_OWNERSHIP'),
                    action + '.GIVE_OWNERSHIP=' + value).to.deep.equal([]);
            }
        }
    });

    it('keeps the parseInt behavior for SWEEP and lock flags', function () {
        expect(fieldErrors(validator, 'SWEEP', { BALANCES: '1.9' }, 'BALANCES')).to.deep.equal([]);
        expect(fieldErrors(validator, 'ISSUE', { LOCK_MINT: '1.9' }, 'LOCK_MINT')).to.deep.equal([]);
    });
});
