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
 * The SDK's unconfirmed-transaction surface: onMempoolAction, getUnconfirmed,
 * and the subscription refcounting they forced.
 *
 * Three separate defects meet here, and every test below is written as
 * BEHAVIOR (a callback fires or does not; a frame reaches the server or does
 * not) rather than as bookkeeping, because all three were invisible in the
 * bookkeeping:
 *
 *  1. MEMPOOL_ACTION / MEMPOOL_REMOVED were absent from ADDRESS_EVENT_TYPES, so
 *     the explorer sent them over the open socket and the client dropped them
 *     without registering a handler. Nothing failed.
 *  2. The per-address delivery guard walked only the SINGULAR address fields. A
 *     mempool frame names `source`, so a correctly-routed delivery to the
 *     RECIPIENT's own channel was rejected as "someone else's frame".
 *  3. ws.subscribe pushed an unconditional replay entry and ws.unsubscribe
 *     removed EVERY match and sent one server unsubscribe, so two subscriptions
 *     to one address channel double-replayed on reconnect and MUTUALLY
 *     DESTROYED each other: the first teardown ended the second's live
 *     delivery. The mock server below models the explorer's entity-keyed
 *     address channel (an unsubscribe really does stop delivery) so that
 *     regression is provable here rather than only on a venue.
 */

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const {
    SENDER,
    XChainSDK,
    bindMempoolSuite,
    mempoolAction,
    waitForCalls
} = require('./mempool_surface.test/support/mempool_surface_support.js');

let server, sdk;

function bindContext(context) {
    server = context.server;
    sdk    = context.sdk;
}

bindMempoolSuite('the roster', bindContext, function () {

    it('carries both mempool frame names', function () {
        expect(XChainSDK.ADDRESS_EVENT_TYPES).to.include('MEMPOOL_ACTION');
        expect(XChainSDK.ADDRESS_EVENT_TYPES).to.include('MEMPOOL_REMOVED');
        expect([...XChainSDK.MEMPOOL_EVENT_TYPES]).to.deep.equal(['MEMPOOL_ACTION', 'MEMPOOL_REMOVED']);
    });

    it('delivers a MEMPOOL_ACTION through plain onAddress', async function () {
        // The roster is what onAddress registers from, so a name missing from
        // it is a frame the server sends and this client silently drops.
        await sdk.connectWs();
        const spy = sinon.spy();
        sdk.onAddress(SENDER, spy);

        server._lastClient.send(JSON.stringify(mempoolAction(SENDER, [])));
        await waitForCalls(spy);

        expect(spy.calledOnce).to.be.true;
        expect(spy.firstCall.args[0].data.tx_hash).to.equal('aa11');
    });
});
