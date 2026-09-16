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
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const ActionWaiter = require('../../../../src/utils/action_waiter.js');
const { FAKE_WIF, makeSdk } = require('./helpers/lifecycle_manager.js');

// submitAction(): waitForIndexer=true

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): waitForIndexer=true", function () {
        it('waits for indexer and populates result.indexed', async function () {
            const indexedAction = { action: 'SEND', status: 'valid', tx_hash: 'fakeid' };
            // Stub ActionWaiter.prototype.waitForTxid to resolve immediately
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves(indexedAction);

            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: true, timeout: 5000, pollInterval: 100 }
            );
            assert.deepStrictEqual(result.indexed, indexedAction);
        });

        it('defaults waitForIndexer to true and calls ActionWaiter', async function () {
            const waiterStub = sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            // Not specifying waitForIndexer → defaults to true
            await lm.submitAction({ action: 'SEND', params: {} }, {}, { wif: FAKE_WIF });
            assert.ok(waiterStub.calledOnce);
        });

        it('fires confirmed progress step after indexer confirms', async function () {
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ status: 'valid' });
            const steps = [];
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            await lm.submitAction(
                { action: 'SEND', params: {} },
                {},
                { wif: FAKE_WIF, waitForIndexer: true, onProgress: (s) => steps.push(s) }
            );
            assert.ok(steps.includes('waiting'));
            assert.ok(steps.includes('confirmed'));
        });
    });
});
