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
const { FAKE_WIF, makeSdk } = require('./helpers/lifecycle_manager.js');

// submitAction(): a chain-REJECTED action must not look like a success.
// These run the REAL ActionWaiter against a fake explorer, so they pin the
// caller-visible contract end to end rather than a stub.

// Fake explorer returning one canned transaction for every poll.
function explorerReturning(txResult) {
    return { getTransaction: async () => txResult };
}

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): rejected actions", function () {
        it('rejects with the indexer-recorded reason when the action is invalid', async function () {
            const sdk = makeSdk({
                ws: null,
                requireExplorer: () => explorerReturning({
                    tx_hash: 'deadbeef',
                    actions: [{ action: 'BET', action_index: 7, status: 'invalid: OUTCOME (range)' }],
                }),
            });
            const lm = new LifecycleManager(sdk);
            await assert.rejects(
                () => lm.submitAction({ action: 'BET', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true, timeout: 3000, pollInterval: 50 }),
                (err) => {
                    assert.strictEqual(err.code, 'ACTION_REJECTED');
                    assert.strictEqual(err.details.reason, 'invalid: OUTCOME (range)');
                    return true;
                });
        });

        it('reports whether the resolved status was read from the indexer or assumed', async function () {
            const sdk = makeSdk({
                ws: null,
                requireExplorer: () => explorerReturning({
                    tx_hash: 'deadbeef',
                    actions: [{ action: 'SEND', action_index: 7, status: 'valid' }],
                }),
            });
            const lm = new LifecycleManager(sdk);
            const result = await lm.submitAction({ action: 'SEND', params: {} }, {},
                { wif: FAKE_WIF, waitForIndexer: true, timeout: 3000, pollInterval: 50 });
            assert.strictEqual(result.indexed.status, 'valid');
            assert.strictEqual(result.indexed.statusKnown, true);
            assert.strictEqual(result.indexed.statusSource, 'indexer');
        });
    });
});

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): rejected actions", function () {
        it('forwards strictStatus so a caller can fail closed on an unreadable status', async function () {
            const sdk = makeSdk({
                ws: null,
                requireExplorer: () => explorerReturning({
                    tx_hash: 'deadbeef',
                    // Status-less action row: the indexer wrote no typed row for this leg.
                    actions: [{ action: 'BET', action_index: 7, status: null }],
                }),
            });
            const lm = new LifecycleManager(sdk);
            await assert.rejects(
                () => lm.submitAction({ action: 'BET', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true, timeout: 1200, pollInterval: 50, strictStatus: true }),
                (err) => {
                    assert.strictEqual(err.code, 'ACTION_STATUS_UNKNOWN');
                    return true;
                });
        });
    });
});
