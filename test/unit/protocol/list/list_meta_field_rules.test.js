/*********************************************************************
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
 * XChain Platform SDK - LIST NAME and DESCRIPTION field rules
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../../src/utils/utility.js');
const Validator  = require('../../../../src/protocol/validator.js');

const validator = new Validator(new Utility());

function check(action, field, value, allFields = {}) {
    return validator.validateFieldValue(action, field, value, allFields);
}

describe('LIST NAME and DESCRIPTION field rules', () => {
    it('accepts a 300-byte DESCRIPTION that the ISSUE rule refuses', () => {
        const value = 'a'.repeat(300);
        expect(check('LIST', 'DESCRIPTION', value)).to.deep.equal([]);
        expect(check('ISSUE', 'DESCRIPTION', value)).to.have.length(1);
    });

    it('refuses a 513-byte DESCRIPTION with the length verdict', () => {
        expect(check('LIST', 'DESCRIPTION', 'a'.repeat(512))).to.deep.equal([]);
        const errors = check('LIST', 'DESCRIPTION', 'a'.repeat(513));
        expect(errors).to.have.length(1);
        expect(errors[0].code).to.equal('INVALID_FIELD_VALUE');
        expect(errors[0].message).to.equal('invalid: DESCRIPTION (length)');
    });

    it('counts NAME in bytes', () => {
        const emoji = '\u{1F600}';
        expect(check('LIST', 'NAME', emoji.repeat(16))).to.deep.equal([]);
        const errors = check('LIST', 'NAME', emoji.repeat(16) + 'a');
        expect(errors).to.have.length(1);
        expect(errors[0].message).to.equal('invalid: NAME (length)');
    });

    it('refuses a lone dash on create only', () => {
        const errors = check('LIST', 'NAME', '-');
        expect(errors).to.have.length(1);
        expect(errors[0].message).to.equal('invalid: NAME (format)');
        expect(check('LIST', 'NAME', '-', { LIST_ACTION_INDEX: '7' })).to.deep.equal([]);
    });

    it('refuses a leading no-break space and a bidi override with the format verdict', () => {
        for (const value of [' name', 'na‮me']) {
            const errors = check('LIST', 'NAME', value);
            expect(errors).to.have.length(1);
            expect(errors[0].message).to.equal('invalid: NAME (format)');
        }
    });

    it('accepts an empty value', () => {
        expect(check('LIST', 'NAME', '')).to.deep.equal([]);
        expect(check('LIST', 'DESCRIPTION', '')).to.deep.equal([]);
    });

    it('adds no delimiter verdict of its own', () => {
        expect(check('LIST', 'NAME', 'a|b')).to.deep.equal([]);
        expect(check('LIST', 'DESCRIPTION', 'a;b')).to.deep.equal([]);
    });

    it('leaves the ISSUE DESCRIPTION rule unchanged', () => {
        const errors = check('ISSUE', 'DESCRIPTION', 'a'.repeat(251));
        expect(errors).to.have.length(1);
        expect(errors[0].message).to.equal('DESCRIPTION must be 250 characters or less');
    });
});
