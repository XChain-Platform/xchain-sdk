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

// submitAction(): a wait that expires after a SUCCESSFUL broadcast

// Tests

describe('LifecycleManager', function () {

    afterEach(() => sinon.restore());

    describe("submitAction(): indexing wait expires", function () {
        // The broadcast happens before the wait, so an expired wait is not a
        // failed action: the transaction is on the network needing a block, which
        // chains with long or irregular block times hit routinely. Marking it is
        // what lets a caller say "accepted, awaiting confirmation" instead of
        // reporting a failure, and what stops a retry from rebuilding and
        // re-spending the same inputs.
        it('marks the timeout as broadcast so it is not read as a failed action', async function () {
            const { SDKActionError } = require('../../../../src/utils/errors.js');
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').rejects(
                new SDKActionError('CONFIRMATION_TIMEOUT', 'not indexed', { txid: 'abc', timeout: 1 }));
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true });
                assert.fail('expected the wait to reject');
            } catch (err) {
                assert.strictEqual(err.code, 'CONFIRMATION_TIMEOUT');
                assert.strictEqual(err.broadcast, true, 'the broadcast succeeded before the wait began');
                assert.ok(err.txid, 'the caller needs the txid to check the mempool');
                assert.strictEqual(err.details.broadcast, true);
            } finally {
                ActionWaiter.prototype.waitForTxid.restore();
            }
        });

        it('leaves other wait failures unmarked', async function () {
            const { SDKActionError } = require('../../../../src/utils/errors.js');
            const sdk = makeSdk();
            const lm = new LifecycleManager(sdk);
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').rejects(
                new SDKActionError('ACTION_INVALID', 'rejected by the indexer', {}));
            try {
                await lm.submitAction({ action: 'SEND', params: {} }, {},
                    { wif: FAKE_WIF, waitForIndexer: true });
                assert.fail('expected the wait to reject');
            } catch (err) {
                assert.strictEqual(err.code, 'ACTION_INVALID');
                assert.strictEqual(err.broadcast, undefined, 'only a timeout means "sent but unconfirmed"');
            } finally {
                ActionWaiter.prototype.waitForTxid.restore();
            }
        });
    });
});
