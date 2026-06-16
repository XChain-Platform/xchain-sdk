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
 * XChain Platform SDK - ActionWaiter Tests
 *
 * The normalized top-level `status` on a waitForTxid result must surface
 * the first non-valid per-action status — wire rejections ("invalid: ...")
 * AND VM execution outcomes ('failed' / 'reverted' / 'out_of_resource').
 * Previously only "invalid:" surfaced, so a failed contract execution read
 * as top-level 'valid' (found via the cross-contract e2e suite, 2026-06-11).
 * requireValid must still reject ONLY on "invalid:" — an indexed-but-failed
 * execution is a successful SUBMISSION and delivery waiters must not throw.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const ActionWaiter = require('../../src/actionWaiter.js');

// Minimal fake SDK: no WebSocket, explorer returns a canned transaction.
function makeWaiter(txResult) {
    const sdk = {
        ws: null,
        _requireExplorer: () => ({
            getTransaction: async () => txResult,
        }),
    };
    return new ActionWaiter(sdk);
}

function tx(actions) {
    return { tx_hash: 'aa'.repeat(32), actions };
}

describe('ActionWaiter.waitForTxid normalized status', function () {

    it('reports valid when every action is valid', async function () {
        const waiter = makeWaiter(tx([{ action: 'SEND', status: 'valid' }]));
        const result = await waiter.waitForTxid('aa'.repeat(32), { timeout: 2000, pollInterval: 50 });
        assert.strictEqual(result.status, 'valid');
    });

    it('surfaces VM execution outcomes (failed) at the top level without rejecting', async function () {
        const waiter = makeWaiter(tx([{ action: 'EXECUTE', status: 'failed' }]));
        const result = await waiter.waitForTxid('aa'.repeat(32), { timeout: 2000, pollInterval: 50 });
        assert.strictEqual(result.status, 'failed', 'execution failure must not read as valid');
    });

    it('surfaces reverted and out_of_resource the same way', async function () {
        for (const status of ['reverted', 'out_of_resource']) {
            const waiter = makeWaiter(tx([{ action: 'EXECUTE', status }]));
            const result = await waiter.waitForTxid('aa'.repeat(32), { timeout: 2000, pollInterval: 50 });
            assert.strictEqual(result.status, status);
        }
    });

    it('still rejects on "invalid:" when requireValid (default)', async function () {
        const waiter = makeWaiter(tx([{ action: 'SEND', status: 'invalid: insufficient funds (FEE)' }]));
        await assert.rejects(
            () => waiter.waitForTxid('aa'.repeat(32), { timeout: 2000, pollInterval: 50 }),
            /ACTION_REJECTED|invalid/);
    });

    it('does NOT reject on a failed execution (successful submission)', async function () {
        const waiter = makeWaiter(tx([{ action: 'EXECUTE', status: 'failed' }]));
        // requireValid default true — must still resolve.
        const result = await waiter.waitForTxid('aa'.repeat(32), { timeout: 2000, pollInterval: 50 });
        assert.strictEqual(result.status, 'failed');
    });

    it('prefers the first non-valid action in multi-action transactions', async function () {
        const waiter = makeWaiter(tx([
            { action: 'SEND', status: 'valid' },
            { action: 'EXECUTE', status: 'reverted' },
            { action: 'MINT', status: 'valid' },
        ]));
        const result = await waiter.waitForTxid('aa'.repeat(32), { timeout: 2000, pollInterval: 50 });
        assert.strictEqual(result.status, 'reverted');
    });
});
