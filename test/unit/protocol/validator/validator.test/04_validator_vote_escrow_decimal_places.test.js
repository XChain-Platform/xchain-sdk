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
const Utility    = require('../../../../../src/utils/utility.js');
const Validator  = require('../../../../../src/protocol/validator.js');

// The indexer arms VOTE_SETTLEMENT_EXACT_ACTIVATION by value: a DEPOSIT or GAS_ESCROW with a
// nonzero digit past the eighth place is refused, '1.500000000' is kept and '1e-9' is refused.
describe('Validator: VOTE DEPOSIT and GAS_ESCROW decimal places', function () {

    let v;
    beforeEach(function () { v = new Validator(new Utility()); });

    const base = { VERSION: 0, TICK: 'GOV', END_BLOCK: '900000', OPTIONS: 'yes,no' };
    const callback = { CALLBACK_CONTRACT: '7', CALLBACK_METHOD: 'onResult' };

    function errorsFor(field, value) {
        const extra = field === 'GAS_ESCROW' ? callback : {};
        return v.validate('VOTE', { ...base, ...extra, [field]: value })
            .filter(e => e.code === 'INVALID_FIELD_VALUE' && e.details.field === field);
    }

    const accepted = ['1.500000000', '0001.5', '0.12345678', '5', '0', '1e3'];
    const refused  = ['1e-9', '1.5e-9', '0.123456789', '0.000000001'];

    for (const field of ['DEPOSIT', 'GAS_ESCROW']) {
        for (const value of accepted) {
            it('accepts ' + field + ' ' + value + ' (no nonzero digit past place 8)', function () {
                expect(errorsFor(field, value)).to.deep.equal([]);
            });
        }
        for (const value of refused) {
            it('refuses ' + field + ' ' + value + ' (nonzero digit past place 8)', function () {
                const errors = errorsFor(field, value);
                expect(errors).to.have.length(1);
                expect(errors[0].message).to.include('at most 8 decimal places');
            });
        }
    }
});
