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
const FormatSelector = require('../../../src/protocol/format_selector.js');

// getFormatFields()

describe('FormatSelector.getFormatFields()', function () {

    it('returns correct ordered array for SEND v0', function () {
        const result = FormatSelector.getFormatFields('SEND', 0);
        expect(result).to.deep.equal(['VERSION', 'TICK', 'AMOUNT', 'DESTINATION', 'MEMO']);
    });

    it('returns correct ordered array for ISSUE v1', function () {
        const result = FormatSelector.getFormatFields('ISSUE', 1);
        expect(result).to.deep.equal(['VERSION', 'TICK', 'DESCRIPTION', 'MEMO']);
    });

    it('returns correct ordered array for SLEEP v0', function () {
        const result = FormatSelector.getFormatFields('SLEEP', 0);
        expect(result).to.deep.equal(['VERSION', 'RESUME_BLOCK', 'MEMO']);
    });

    it('returns correct ordered array for SLEEP v1', function () {
        const result = FormatSelector.getFormatFields('SLEEP', 1);
        expect(result).to.deep.equal(['VERSION', 'RESUME_BLOCK', 'TICK', 'MEMO']);
    });

    it('returns array (not a string)', function () {
        const result = FormatSelector.getFormatFields('SEND', 0);
        expect(result).to.be.an('array');
    });

    it('repeating-field formats include duplicates in the array', function () {
        // SEND v1: VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO
        const result = FormatSelector.getFormatFields('SEND', 1);
        const amountCount = result.filter(f => f === 'AMOUNT').length;
        const destCount = result.filter(f => f === 'DESTINATION').length;
        expect(amountCount).to.equal(2);
        expect(destCount).to.equal(2);
    });

});
