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

// getPopulatedFields()

describe('FormatSelector.getPopulatedFields()', function () {

    it('returns keys whose values are non-null, non-undefined, non-empty strings', function () {
        const result = FormatSelector.getPopulatedFields({
            TICK: 'TOKEN', AMOUNT: '100', DESTINATION: 'addr1'
        });
        expect(result).to.include.members(['TICK', 'AMOUNT', 'DESTINATION']);
        expect(result).to.have.length(3);
    });

    it('filters out null values', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: 'TOKEN', AMOUNT: null });
        expect(result).to.deep.equal(['TICK']);
    });

    it('filters out undefined values', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: 'TOKEN', AMOUNT: undefined });
        expect(result).to.deep.equal(['TICK']);
    });

    it('filters out empty string values', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: 'TOKEN', AMOUNT: '' });
        expect(result).to.deep.equal(['TICK']);
    });

    it('returns an empty array when all fields are empty', function () {
        const result = FormatSelector.getPopulatedFields({ TICK: null, AMOUNT: undefined, MEMO: '' });
        expect(result).to.deep.equal([]);
    });

    it('returns an empty array for an empty object', function () {
        const result = FormatSelector.getPopulatedFields({});
        expect(result).to.deep.equal([]);
    });

    it('includes fields with numeric zero value (0)', function () {
        // 0 is not null/undefined/empty-string, so it should be kept
        const result = FormatSelector.getPopulatedFields({ DECIMALS: 0, TICK: 'TOKEN' });
        expect(result).to.include('DECIMALS');
    });

    it('includes fields with boolean false value', function () {
        // false is not null/undefined/empty-string, so it should be kept
        const result = FormatSelector.getPopulatedFields({ LOCK_MINT: false, TICK: 'TOKEN' });
        expect(result).to.include('LOCK_MINT');
    });

});
