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
 * XChain Platform SDK - FormatSelector Tests
 *
 * Comprehensive Mocha + Chai test suite for the FormatSelector class.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const FormatSelector = require('../../../../src/protocol/format_selector.js');
const { SDKFormatError } = require('../../../../src/utils/errors.js');

// Explicit version + rest-field handling
describe('FormatSelector: explicit version + rest fields', function () {

    it('honours a valid explicit version', function () {
        const result = FormatSelector.select('SEND', { TICK: 'X', AMOUNT: '1', DESTINATION: 'a' }, 0);
        expect(result.version).to.equal(0);
    });

    it('throws INVALID_VERSION for an undefined explicit version', function () {
        expect(() => FormatSelector.select('SEND', { TICK: 'X' }, 99))
            .to.throw(SDKFormatError).that.has.property('code', 'INVALID_VERSION');
    });

    it('serialize expands a rest-field into individual pipe segments', function () {
        // DEPLOY v0 = VERSION|CODE_ENCODING|GAS_LIMIT|...CONSTRUCTOR_PARAMS
        const out = FormatSelector.serialize('DEPLOY', 0, {
            CODE_ENCODING: 'base64', GAS_LIMIT: '100', CONSTRUCTOR_PARAMS: ['a', 'b', 'c'],
        });
        expect(out).to.equal('DEPLOY|0|base64|100|a|b|c');
    });

    it('serialize emits nothing for an empty/absent rest-field array', function () {
        const out = FormatSelector.serialize('DEPLOY', 0, { CODE_ENCODING: 'base64', GAS_LIMIT: '100' });
        expect(out).to.equal('DEPLOY|0|base64|100');
    });

    it('serialize coerces null/undefined rest-field items to empty segments', function () {
        const out = FormatSelector.serialize('DEPLOY', 0, {
            CODE_ENCODING: 'b', GAS_LIMIT: '1', CONSTRUCTOR_PARAMS: ['x', null, 'z'],
        });
        expect(out).to.equal('DEPLOY|0|b|1|x||z');
    });

    it('estimateLength accounts for rest-field array contents', function () {
        const withParams = FormatSelector.estimateLength('DEPLOY', 0, {
            CODE_ENCODING: 'base64', GAS_LIMIT: '100', CONSTRUCTOR_PARAMS: ['aaaa', 'bbbb'],
        });
        const without = FormatSelector.estimateLength('DEPLOY', 0, {
            CODE_ENCODING: 'base64', GAS_LIMIT: '100',
        });
        expect(withParams).to.be.greaterThan(without);
    });
});
