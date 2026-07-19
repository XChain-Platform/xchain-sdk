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
 * the first non-valid per-action status: wire rejections ("invalid: ...")
 * AND VM execution outcomes ('failed' / 'reverted' / 'out_of_resource').
 * Previously only "invalid:" surfaced, so a failed contract execution read
 * as top-level 'valid' (found via the cross-contract e2e suite, 2026-06-11).
 * requireValid must still reject ONLY on "invalid:": an indexed-but-failed
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
        // requireValid default true: must still resolve.
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

// WebSocket fast-path: a live WS emits one NEW_ACTION per action. The handler
// must honor opts.actionIndex the same way the poll path does, or a neighboring
// action's event settles the wait with the wrong action's status.
describe('ActionWaiter.waitForTxid WebSocket actionIndex filtering', function () {

    const TXID = 'bb'.repeat(32);

    // Fake SDK with an event-emitting WS. `txResult` is what the explorer poll
    // returns (default null = poll never resolves). For a TARGETED wait the WS path
    // settles directly, so the poll result is irrelevant; for an UNTARGETED wait the
    // WS event triggers an authoritative poll, so the tx must be supplied there.
    function makeWsWaiter(txResult = null) {
        const listeners = {};
        const ws = {
            isConnected: () => true,
            on:  (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
            off: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); },
            emit:(evt, msg) => { (listeners[evt] || []).slice().forEach(fn => fn(msg)); },
        };
        const sdk = { ws, _requireExplorer: () => ({ getTransaction: async () => txResult }) };
        return { waiter: new ActionWaiter(sdk), ws };
    }

    it('ignores a neighbor action_index event and settles on the target action', async function () {
        const { waiter, ws } = makeWsWaiter();
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: 1 });
        // Neighbor action 0 (valid) arrives first: must be IGNORED (pre-fix it would
        // have resolved the wait, masking the target action's rejection).
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 0, status: 'valid' } });
        // Target action 1 (invalid) arrives: must settle -> reject.
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 1, status: 'invalid: bad' } });
        await assert.rejects(() => p, /ACTION_REJECTED|invalid/);
    });

    it('coerces string vs number action_index when matching', async function () {
        const { waiter, ws } = makeWsWaiter();
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: 2 });
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: '2', status: 'valid' } });
        const result = await p;
        assert.strictEqual(result.action_index, '2');
    });

    it('without actionIndex, a WS event triggers an authoritative poll of the whole tx', async function () {
        // Untargeted wait: the WS event is only a "tx is indexed" signal. The result
        // reflects the FULL transaction read back through the explorer (all actions),
        // not the single action the event carried.
        const { waiter, ws } = makeWsWaiter({
            tx_hash: TXID,
            actions: [{ action: 'SEND', action_index: 0, status: 'valid' }],
        });
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50 });
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 0, status: 'valid' } });
        const result = await p;
        assert.strictEqual(result.status, 'valid');
        assert.strictEqual(result.tx_hash, TXID);
    });

    it('without actionIndex, a valid sub-action WS event does NOT mask a sibling invalid action', async function () {
        // The core multi-action fix: in a BATCH the WS emits one event per sub-action.
        // A valid sub-action arriving first must NOT settle the wait as success while a
        // sibling in the same tx is invalid. The WS event instead triggers a poll that
        // sees the full action set and rejects, matching the poll path exactly.
        const { waiter, ws } = makeWsWaiter({
            tx_hash: TXID,
            actions: [
                { action: 'SEND', action_index: 0, status: 'valid' },
                { action: 'MINT', action_index: 1, status: 'invalid: over max supply (AMOUNT)' },
            ],
        });
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50 });
        // The valid sub-action event arrives first. Pre-fix this settled success and
        // masked the sibling rejection.
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 0, status: 'valid' } });
        await assert.rejects(() => p, /ACTION_REJECTED|invalid/);
    });

    it('without actionIndex + requireValid:false, surfaces the whole-tx status, not the single event', async function () {
        // requireValid off (delivery waiters): must still report the normalized
        // whole-tx status from the poll, not the lone valid event's status.
        const { waiter, ws } = makeWsWaiter({
            tx_hash: TXID,
            actions: [
                { action: 'SEND', action_index: 0, status: 'valid' },
                { action: 'EXECUTE', action_index: 1, status: 'reverted' },
            ],
        });
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, requireValid: false });
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 0, status: 'valid' } });
        const result = await p;
        assert.strictEqual(result.status, 'reverted');
    });
});
