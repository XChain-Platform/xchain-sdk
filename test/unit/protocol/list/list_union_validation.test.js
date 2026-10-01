/***** GENERATED ******************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - LIST TYPE=3 union item validation matrix
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../../src/utils/utility.js');
const Validator  = require('../../../../src/protocol/validator.js');

function validate(fields) {
    return new Validator(new Utility()).validate('LIST', fields);
}

function matching(errors, code, field) {
    return errors.filter(error => error.code === code && error.details.field === field);
}

describe('LIST TYPE=3 union item validation', () => {
    it('accepts one or more positive action indexes', () => {
        expect(validate({ TYPE: 3, ITEM: '1' })).to.deep.equal([]);
        expect(validate({ TYPE: 3, ITEM: ['1', '2', '987654321'] })).to.deep.equal([]);
    });

    it('requires ITEM when none is supplied', () => {
        const absent = validate({ TYPE: 3 });
        const emptyArray = validate({ TYPE: 3, ITEM: [] });
        expect(matching(absent, 'MISSING_REQUIRED_FIELD', 'ITEM')).to.have.length(1);
        expect(matching(emptyArray, 'MISSING_REQUIRED_FIELD', 'ITEM')).to.have.length(1);
    });

    it('accepts exactly LIST_UNION_MAX_MEMBERS items', () => {
        const items = Array.from({ length: 16 }, (_, index) => String(index + 1));
        expect(validate({ TYPE: 3, ITEM: items })).to.deep.equal([]);
    });

    it('rejects more than LIST_UNION_MAX_MEMBERS items', () => {
        const items = Array.from({ length: 17 }, (_, index) => String(index + 1));
        const errors = validate({ TYPE: 3, ITEM: items });
        const invalid = matching(errors, 'INVALID_FIELD_VALUE', 'ITEM');
        expect(invalid).to.have.length(1);
        expect(invalid[0].details.constraint).to.deep.equal({ max: 16 });
    });

    ['^12', '0', '-1', '1.5', 'MYTOKEN', '01', ''].forEach(item => {
        it('rejects non-action-index ITEM ' + JSON.stringify(item), () => {
            const errors = validate({ TYPE: 3, ITEM: [item] });
            expect(matching(errors, 'INVALID_FIELD_VALUE', 'ITEM')).to.have.length(1);
        });
    });

    it('rejects duplicate action indexes', () => {
        const errors = validate({ TYPE: 3, ITEM: ['7', '8', '7'] });
        const invalid = matching(errors, 'INVALID_FIELD_VALUE', 'ITEM');
        expect(invalid).to.have.length(1);
        expect(invalid[0].details.value).to.equal('7');
    });

    it('treats numeric and string forms of an index as duplicates', () => {
        const errors = validate({ TYPE: 3, ITEM: [7, '7'] });
        expect(matching(errors, 'INVALID_FIELD_VALUE', 'ITEM')).to.have.length(1);
    });

    it('does not apply union rules to TYPE=1 creates', () => {
        expect(validate({ TYPE: 1, ITEM: ['MYTOKEN', 'MYTOKEN'] })).to.deep.equal([]);
    });

    it('does not apply union rules to TYPE=2 creates', () => {
        expect(validate({ TYPE: 2, ITEM: ['^57', '^57'] })).to.deep.equal([]);
    });

    it('does not apply union rules to version 1 edits', () => {
        const fields = { VERSION: 1, EDIT: 1, LIST_ACTION_INDEX: 5, TYPE: 3, ITEM: ['^bad', '^bad'] };
        expect(validate(fields)).to.deep.equal([]);
    });
});
