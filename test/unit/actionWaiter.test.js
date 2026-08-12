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

// A wait must never report chain-confirmed success it did not read.
// The waiter used to synthesize `status: 'valid'` from an EMPTY evidence set:
// a targeted wait whose action_index matched nothing, a transaction the
// explorer returned with no action rows, or an action row the explorer carries
// with no status at all. Each of those resolved the promise reporting 'valid',
// so a rejected action was indistinguishable from a successful one.
describe('ActionWaiter.waitForTxid status honesty', function () {

    const TXID = 'cc'.repeat(32);

    it('a targeted wait does not resolve valid when the target action is absent', async function () {
        // Only action 0 is in the tx; the caller is waiting on action 1. The old
        // filter produced an empty set, found no 'invalid', and resolved 'valid'.
        const waiter = makeWaiter({
            tx_hash: TXID,
            actions: [{ action: 'SEND', action_index: 0, status: 'valid' }],
        });
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 1200, pollInterval: 50, actionIndex: 1 }),
            /CONFIRMATION_TIMEOUT|Timed out/);
    });

    it('a targeted wait still rejects on the target action own invalid status', async function () {
        const waiter = makeWaiter({
            tx_hash: TXID,
            actions: [
                { action: 'SEND', action_index: 0, status: 'valid' },
                { action: 'BET',  action_index: 1, status: 'invalid: OUTCOME (range)' },
            ],
        });
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: 1 }),
            (err) => {
                assert.strictEqual(err.code, 'ACTION_REJECTED');
                // The indexer-recorded reason must reach the caller verbatim.
                assert.strictEqual(err.details.reason, 'invalid: OUTCOME (range)');
                return true;
            });
    });

    it('an indexed transaction with no action rows does not resolve valid', async function () {
        const waiter = makeWaiter({ tx_hash: TXID, actions: [] });
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 1200, pollInterval: 50 }),
            /CONFIRMATION_TIMEOUT|Timed out/);
    });

    it('flags an action the indexer reports without a status as unread, not confirmed', async function () {
        // BET cancel/resolve (indexer bet.js: formats 1 and 3 write no typed row)
        // reach the explorer with a NULL status. Reporting that as 'valid' is an
        // assumption, so it must be labelled as one.
        const waiter = makeWaiter({
            tx_hash: TXID,
            actions: [{ action: 'BET', action_index: 4, status: null }],
        });
        const result = await waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50 });
        assert.strictEqual(result.statusKnown, false, 'the status was never read from the indexer');
        assert.strictEqual(result.statusSource, 'assumed');
        assert.deepStrictEqual(result.statusUnknownActions, [4]);
    });

    it('labels a status it did read as indexer-sourced', async function () {
        const waiter = makeWaiter({
            tx_hash: TXID,
            actions: [{ action: 'SEND', action_index: 0, status: 'valid' }],
        });
        const result = await waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50 });
        assert.strictEqual(result.status, 'valid');
        assert.strictEqual(result.statusKnown, true);
        assert.strictEqual(result.statusSource, 'indexer');
    });

    it('strictStatus rejects rather than assuming validity it could not read', async function () {
        const waiter = makeWaiter({
            tx_hash: TXID,
            actions: [{ action: 'BET', action_index: 4, status: null }],
        });
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 1200, pollInterval: 50, strictStatus: true }),
            (err) => {
                assert.strictEqual(err.code, 'ACTION_STATUS_UNKNOWN');
                return true;
            });
    });

    it('strictStatus with requireValid:false still resolves (delivery waiters)', async function () {
        // strictStatus is an enforcement of requireValid, so turning validity
        // enforcement off must not start throwing on an unreadable status.
        const waiter = makeWaiter({
            tx_hash: TXID,
            actions: [{ action: 'BET', action_index: 4, status: null }],
        });
        const result = await waiter.waitForTxid(TXID,
            { timeout: 2000, pollInterval: 50, strictStatus: true, requireValid: false });
        assert.strictEqual(result.statusKnown, false);
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

    it('a targeted event carrying NO status defers to the poll instead of settling', async function () {
        // The WS payload for some actions arrives without a status. Settling from it
        // reported success the indexer never claimed; the poll reads the real row.
        const { waiter, ws } = makeWsWaiter({
            tx_hash: TXID,
            actions: [{ action: 'BET', action_index: 1, status: 'invalid: OUTCOME (range)' }],
        });
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: 1 });
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 1 } });
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
