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
 * XChain Platform SDK - LIST metadata field rules
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { listMetaFieldError } = require('../../../../src/protocol/validator/list_meta_rules.js');

const FIELDS = [
    { field: 'NAME', maxBytes: 64 },
    { field: 'DESCRIPTION', maxBytes: 512 },
];

describe('LIST metadata field rules', function () {
    for (const { field, maxBytes } of FIELDS) {
        describe(field, function () {
            const check = (value, isCreate = false) =>
                listMetaFieldError(field, value, maxBytes, isCreate);

            it('returns each field verdict in rule order', function () {
                expect(check('|;' + 'a'.repeat(maxBytes))).to.equal('invalid: ' + field + ' (pipe)');
                expect(check(';' + 'a'.repeat(maxBytes))).to.equal('invalid: ' + field + ' (semicolon)');
                expect(check('a'.repeat(maxBytes + 1))).to.equal('invalid: ' + field + ' (length)');
                expect(check('\u202E')).to.equal('invalid: ' + field + ' (format)');
            });

            it('accepts empty fields and a four-byte emoji at the byte cap', function () {
                const atCap = 'a'.repeat(maxBytes - 4) + '\u{1F600}';
                expect(Buffer.byteLength(atCap, 'utf8')).to.equal(maxBytes);
                expect(check('')).to.equal(null);
                expect(check(atCap)).to.equal(null);
            });

            it('refuses explicit meta-text grammar edge cases', function () {
                expect(check('\u00A0leading')).to.equal('invalid: ' + field + ' (format)');
                expect(check('text\u202Etext')).to.equal('invalid: ' + field + ' (format)');
                expect(check('\uD800')).to.equal('invalid: ' + field + ' (format)');
            });

            it('refuses the clear sentinel in create and accepts it in set', function () {
                expect(check('-', true)).to.equal('invalid: ' + field + ' (format)');
                expect(check('-', false)).to.equal(null);
            });
        });
    }
});
