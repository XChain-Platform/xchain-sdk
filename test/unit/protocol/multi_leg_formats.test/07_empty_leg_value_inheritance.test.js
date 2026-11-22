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
 * XChain Platform SDK - empty leg values inherit the top-level value
 *
 * The validator accepts an empty leg value next to a top-level one, so the
 * serializer must emit that top-level value rather than an empty slot that
 * the network rejects after the fee is paid.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const Validator = require('../../../../src/protocol/validator.js');
const Utility = require('../../../../src/utils/utility.js');
const { parse } = require('../../../../src/decoder/parse.js');

const validator = new Validator(new Utility());

describe('empty leg values inherit the top-level value', function () {

    for (const empty of ['', null]) {
        it('serializes a single-leg DESTROY leg TICK of ' + JSON.stringify(empty) + ' as the top-level ticker', function () {
            const fields = { TICK: 'TOKEN', AMOUNT: '1', LEGS: [{ TICK: empty }] };
            expect(validator.validate('DESTROY', fields)).to.deep.equal([]);
            expect(FormatSelector.serialize('DESTROY', 0, fields)).to.equal('DESTROY|0|TOKEN|1');
        });

        it('serializes a repeated DESTROY leg TICK of ' + JSON.stringify(empty) + ' as the top-level ticker', function () {
            const fields = { TICK: 'TOKEN', LEGS: [{ TICK: empty, AMOUNT: '1' }, { TICK: 'OTHER', AMOUNT: '2' }] };
            expect(validator.validate('DESTROY', fields)).to.deep.equal([]);
            expect(FormatSelector.serialize('DESTROY', 1, fields)).to.equal('DESTROY|1|TOKEN|1|OTHER|2');
        });
    }

    it('still reports an empty leg TICK with no top-level TICK as missing', function () {
        const errors = validator.validate('DESTROY', { AMOUNT: '1', LEGS: [{ TICK: '' }] });
        const missing = errors.filter(e => e.code === 'MISSING_REQUIRED_FIELD');
        expect(missing.map(e => e.details.field)).to.include('TICK');
    });

    it('keeps a non-empty leg value over the top-level one', function () {
        const fields = { TICK: 'TOKEN', AMOUNT: '1', LEGS: [{ TICK: 'OWN' }] };
        expect(FormatSelector.serialize('DESTROY', 0, fields)).to.equal('DESTROY|0|OWN|1');
    });

    it('round-trips a parsed SEND v3 whose second leg has an empty MEMO', function () {
        const actionString = FormatSelector.serialize('SEND', 3, { LEGS: [
            { TICK: 'A', AMOUNT: '1', DESTINATION: 'd0', MEMO: 'hi' },
            { TICK: 'B', AMOUNT: '2', DESTINATION: 'd1', MEMO: '' },
        ] });
        const parsed = parse(actionString, { validate: false });
        const again = FormatSelector.serialize('SEND', 3, Object.assign({}, parsed.params, { LEGS: parsed.legs }));
        expect(again).to.equal(actionString);
        expect(parsed.legs[1].MEMO).to.equal('');
    });
});
