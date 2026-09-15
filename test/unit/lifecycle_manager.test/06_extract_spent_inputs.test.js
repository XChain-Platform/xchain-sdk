// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const { buildTestPsbtHex, makeSdk } = require('./helpers/lifecycle_manager.js');

// _extractSpentInputs()

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("_extractSpentInputs()", function () {
        it('returns array of {txid, vout} objects from a valid PSBT hex', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const psbtHex = buildTestPsbtHex();
            const inputs = lm._extractSpentInputs(psbtHex);
            assert.ok(Array.isArray(inputs));
            assert.ok(inputs.length >= 1);
            assert.ok(typeof inputs[0].txid === 'string' && inputs[0].txid.length === 64);
            assert.ok(typeof inputs[0].vout === 'number');
        });

        it('returns empty array for invalid PSBT hex (does not throw)', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const result = lm._extractSpentInputs('not-valid-psbt-hex');
            assert.deepStrictEqual(result, []);
        });

        it('returns empty array for empty string', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            assert.deepStrictEqual(lm._extractSpentInputs(''), []);
        });
    });
});
