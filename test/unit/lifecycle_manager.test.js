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
const LifecycleManager = require('../../src/carrier/lifecycle_manager.js');
const { makeSdk } = require('./lifecycle_manager.test/helpers/lifecycle_manager.js');

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    // Constructor
    describe('constructor', function () {
        it('stores the sdk reference', function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            assert.strictEqual(lm.sdk, sdk);
        });
    });

    // submitAction(): missing WIF
    describe('submitAction(): missing WIF', function () {
        it('throws SDKConfigError MISSING_WIF when wif is absent', async function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {}, {});
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_WIF');
            }
        });

        it('throws MISSING_WIF when wif is null', async function () {
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {}, { wif: null });
                assert.fail('should have thrown');
            } catch (err) {
                assert.strictEqual(err.code, 'MISSING_WIF');
            }
        });
    });
});
