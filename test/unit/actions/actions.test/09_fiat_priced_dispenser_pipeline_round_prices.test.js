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
 * XChain Platform SDK - Actions Class Tests
 *
 * Comprehensive unit tests for the Actions class covering all 19 ACTION
 * types, format version selection, result structure, error cases,
 * pre-flight encoding validation, validateAction dry-run, and
 * introspection methods.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { SDKValidationError } = require('../../../../src/utils/errors.js');
const { createActions } = require('./helpers/create_actions.js');

// FIAT_AMOUNT end-to-end: the exact defect path was createAction's
// setNumberFormats stripping trailing zeros ("10.00" -> "10") BEFORE a
// validator regex that demanded exactly two decimals, so every round fiat
// price was rejected. FIAT_AMOUNT is excluded from numeric reformatting
// and the validator mirrors the indexer's <= 2 decimals consensus rule.

describe('Actions – fiat-priced DISPENSER pipeline (round prices)', function () {

    let actions;
    beforeEach(function () { actions = createActions(); });

    function fiatDispenser(fiatAmount) {
        return actions.createAction({
            action: 'DISPENSER',
            params: {
                giveTick: 'TOKEN', giveAmount: '10',
                getTick: 'BTC', getAmount: '0.001',
                fiatCode: 'USD', fiatAmount: fiatAmount
            }
        });
    }

    it("accepts round and half prices ('10.00', '1.50', '5.00', '0.50')", function () {
        for (const price of ['10.00', '1.50', '5.00', '0.50']) {
            let result = fiatDispenser(price);
            // The fiat price reaches the wire untouched (no trailing-zero strip).
            expect(result.actionString.split('|')).to.include(price);
        }
    });

    it("still accepts a non-round price ('19.99')", function () {
        expect(fiatDispenser('19.99').actionString.split('|')).to.include('19.99');
    });

    it("rejects a three-decimal price ('1.999')", function () {
        expect(() => fiatDispenser('1.999')).to.throw(SDKValidationError);
    });
});
