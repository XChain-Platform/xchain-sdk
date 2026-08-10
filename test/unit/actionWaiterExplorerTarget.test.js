/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * : the ActionWaiter's explorer target must be injectable.
 *
 * The waiter used to poll sdk.explorer unconditionally, so every SDK-driven
 * action against an ISOLATED regtest venue (its own node/decoder/indexer, no
 * colocated explorer) polled the SHARED explorer hub discovery advertised and
 * died on CONFIRMATION_TIMEOUT with a perfectly good transaction on chain
 * ( A2 drill). These pin the override, its precedence, and the WebSocket
 * suppression that keeps a foreign stack's events from settling the wait.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const ActionWaiter = require('../../src/actionWaiter.js');
const { waitFor } = require('../helpers/wait.js');

const TXID = 'aa'.repeat(32);

// SDK whose OWN explorer never sees the transaction: the shared-explorer
// situation an isolated venue lands in.
function sharedOnlySdk(opts = {}) {
    let calls = { shared: 0 };
    const sdk = {
        ws: opts.ws || null,
        options: { network: 'dogecoin-regtest', timeout: 1234 },
        _requireExplorer: () => ({
            getTransaction: async () => { calls.shared++; return null; },
            getAction:      async () => { calls.shared++; return null; }
        })
    };
    return { sdk, calls };
}

// The isolated venue's explorer: it HAS the transaction.
function venueExplorer(counter) {
    return {
        getTransaction: async () => { counter.venue++; return { tx_hash: TXID, actions: [{ action: 'SEND', action_index: 0, status: 'valid' }] }; },
        getAction:      async () => { counter.venue++; return { action_index: 7, action: 'SEND' }; }
    };
}

describe('ActionWaiter explorer target injection ', function () {

    it('without an override the shared explorer is polled and the wait times out', async function () {
        const { sdk, calls } = sharedOnlySdk();
        const waiter = new ActionWaiter(sdk);
        await assert.rejects(
            () => waiter.waitForTxid(TXID, { timeout: 1500, pollInterval: 50 }),
            /CONFIRMATION_TIMEOUT|Timed out/);
        assert.ok(calls.shared > 0, 'the SDK explorer was the one polled');
    });

    it('a per-call explorer override resolves against the isolated venue', async function () {
        const { sdk, calls } = sharedOnlySdk();
        calls.venue = 0;
        const waiter = new ActionWaiter(sdk);
        const result = await waiter.waitForTxid(TXID, {
            timeout: 3000, pollInterval: 50, explorer: venueExplorer(calls)
        });
        assert.strictEqual(result.tx_hash, TXID);
        assert.strictEqual(result.status, 'valid');
        assert.ok(calls.venue > 0, 'the injected explorer was polled');
        assert.strictEqual(calls.shared, 0, 'the shared explorer must not be touched');
    });

    it('a constructor override applies to every wait on that waiter', async function () {
        const { sdk, calls } = sharedOnlySdk();
        calls.venue = 0;
        const waiter = new ActionWaiter(sdk, { explorer: venueExplorer(calls) });
        const result = await waiter.waitForTxid(TXID, { timeout: 3000, pollInterval: 50 });
        assert.strictEqual(result.tx_hash, TXID);
        assert.strictEqual(calls.shared, 0);
    });

    it('a per-call override beats the constructor override', async function () {
        const { sdk, calls } = sharedOnlySdk();
        calls.venue = 0;
        let ctorCalls = 0;
        const waiter = new ActionWaiter(sdk, {
            explorer: { getTransaction: async () => { ctorCalls++; return null; } }
        });
        const result = await waiter.waitForTxid(TXID, {
            timeout: 3000, pollInterval: 50, explorer: venueExplorer(calls)
        });
        assert.strictEqual(result.tx_hash, TXID);
        assert.strictEqual(ctorCalls, 0, 'the constructor target must be superseded');
    });

    it('explorerUrl + explorerPort build a client aimed at the venue', function () {
        const { sdk } = sharedOnlySdk();
        const waiter = new ActionWaiter(sdk, { explorerUrl: '127.0.0.1', explorerPort: 3520 });
        assert.ok(waiter.explorer, 'an explorer client was built');
        assert.strictEqual(waiter.explorer.baseUrl, '127.0.0.1');
        assert.strictEqual(waiter.explorer.port, 3520);
        // The override changes only the TARGET: coin prefix + timeout still
        // come from the SDK, so a redirected wait reads the same coin's data.
        assert.strictEqual(waiter.explorer.timeout, 1234);
        const ExplorerClient = require('../../src/explorer.js');
        assert.strictEqual(waiter.explorer.coin,
            new ExplorerClient({ network: 'dogecoin-regtest' }).coin);
    });

    it('waitForActionIndex honors the override too', async function () {
        const { sdk, calls } = sharedOnlySdk();
        calls.venue = 0;
        const waiter = new ActionWaiter(sdk);
        const result = await waiter.waitForActionIndex(7, {
            timeout: 3000, pollInterval: 50, explorer: venueExplorer(calls)
        });
        assert.strictEqual(result.action_index, 7);
        assert.strictEqual(calls.shared, 0);
    });

    it('an overridden wait ignores the SDK WebSocket (it follows the OTHER stack)', async function () {
        // A foreign stack's NEW_ACTION for the same txid must not settle a wait
        // that was explicitly pointed somewhere else.
        const ws = new EventEmitter();
        ws.isConnected = () => true;
        ws.off = ws.removeListener.bind(ws);
        const { sdk, calls } = sharedOnlySdk({ ws });
        calls.venue = 0;
        const waiter = new ActionWaiter(sdk);
        const p = waiter.waitForTxid(TXID, {
            timeout: 3000, pollInterval: 50, actionIndex: 0,
            explorer: venueExplorer(calls)
        });
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 0, status: 'invalid: foreign stack' } });
        const result = await p;
        assert.strictEqual(result.status, 'valid', 'the injected explorer decided, not the foreign event');
        assert.strictEqual(ws.listenerCount('NEW_ACTION'), 0, 'no listener was ever attached');
    });

    it('an un-overridden wait still uses the WebSocket fast path', async function () {
        const ws = new EventEmitter();
        ws.isConnected = () => true;
        ws.off = ws.removeListener.bind(ws);
        const { sdk } = sharedOnlySdk({ ws });
        const waiter = new ActionWaiter(sdk);
        const p = waiter.waitForTxid(TXID, { timeout: 2000, pollInterval: 50, actionIndex: 0 });
        // Wait for the listener to actually be attached, which is the condition
        // the next line asserts; the old fixed 20ms was that same wait, guessed at.
        await waitFor(() => ws.listenerCount('NEW_ACTION') === 1,
            { message: 'the waiter never attached its NEW_ACTION listener' });
        assert.strictEqual(ws.listenerCount('NEW_ACTION'), 1);
        ws.emit('NEW_ACTION', { data: { tx_hash: TXID, action_index: 0, status: 'valid' } });
        const result = await p;
        assert.strictEqual(result.status, 'valid');
    });
});
