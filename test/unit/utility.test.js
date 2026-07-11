// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const Utility = require('../../src/utility.js');

describe('Utility.isValidAmountFormat (indexer parity)', function () {

    let utils;

    beforeEach(function () {
        utils = new Utility();
    });

    it('rejects negative amounts (parity with indexer consensus guard)', function () {
        // The exact drift input: without the negative guard this returned true.
        assert.strictEqual(utils.isValidAmountFormat(8, '-1.5'), false);
        assert.strictEqual(utils.isValidAmountFormat(8, '-100'), false);
        assert.strictEqual(utils.isValidAmountFormat(0, '-1'), false);
        assert.strictEqual(utils.isValidAmountFormat(8, '-0.00000001'), false);
    });

    it('rejects unsafe object amounts', function () {
        const unsafe = Object.create(null); // no toString
        assert.strictEqual(utils.isValidAmountFormat(8, unsafe), false);
    });

    it('still accepts valid positive amounts', function () {
        assert.strictEqual(utils.isValidAmountFormat(8, '1.5'), true);
        assert.strictEqual(utils.isValidAmountFormat(0, '100'), true);
        assert.strictEqual(utils.isValidAmountFormat(8, '0'), true);
    });

    it('still rejects over-precise amounts (fractional cap intact)', function () {
        assert.strictEqual(utils.isValidAmountFormat(2, '1.123'), false);
    });
});
