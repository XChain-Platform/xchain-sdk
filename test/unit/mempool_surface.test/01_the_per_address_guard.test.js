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
    RECIPIENT,
    SENDER,
    STRANGER,
    bindMempoolSuite,
    mempoolAction,
    mempoolRemoved,
    waitAtBarrier,
    waitForCalls
} = require('./support/mempool_surface_support.js');

let server, sdk;

function bindContext(context) {
    server = context.server;
    sdk    = context.sdk;
}

async function barrier() {
    await waitAtBarrier(sdk, server);
}

bindMempoolSuite('the per-address guard', bindContext, function () {

    it('delivers to a recipient named only in destinations', async function () {
        await sdk.connectWs();
        const spy = sinon.spy();
        sdk.onMempoolAction(RECIPIENT, spy);

        // The frame's only singular address field is `source`, and it is
        // somebody else: without the destinations rule this is dropped.
        server._lastClient.send(JSON.stringify(mempoolAction(SENDER, [RECIPIENT])));
        await waitForCalls(spy);

        expect(spy.calledOnce).to.be.true;
        expect(spy.firstCall.args[0].data.destinations).to.deep.equal([RECIPIENT]);
    });

    it('delivers a MEMPOOL_REMOVED to that same recipient', async function () {
        await sdk.connectWs();
        const spy = sinon.spy();
        sdk.onMempoolAction(RECIPIENT, spy);

        server._lastClient.send(JSON.stringify(mempoolRemoved(SENDER, [RECIPIENT])));
        await waitForCalls(spy);

        expect(spy.calledOnce).to.be.true;
        expect(spy.firstCall.args[0].type).to.equal('MEMPOOL_REMOVED');
    });

    it('drops a frame whose only parties are other addresses', async function () {
        await sdk.connectWs();
        const spy = sinon.spy();
        sdk.onMempoolAction(RECIPIENT, spy);

        server._lastClient.send(JSON.stringify(mempoolAction(SENDER, [STRANGER])));
        await barrier();

        expect(spy.called).to.be.false;
    });
});

bindMempoolSuite('the per-address guard', bindContext, function () {

    it('tolerates destinations being absent (the global-channel shape)', async function () {
        // The global `mempool` channel omits destinations entirely, so the
        // guard must fall back to the singular fields: the source still gets
        // its own frame, and nobody else does.
        await sdk.connectWs();
        const mine    = sinon.spy();
        const another = sinon.spy();
        sdk.onMempoolAction(SENDER, mine);
        sdk.onMempoolAction(RECIPIENT, another);

        server._lastClient.send(JSON.stringify(mempoolAction(SENDER, undefined)));
        await waitForCalls(mine);
        await barrier();

        expect(mine.calledOnce).to.be.true;
        expect(another.called).to.be.false;
    });

    it('tolerates an empty destinations array', async function () {
        // Empty names nobody, so it must not be read as "this frame belongs
        // to someone else" and must not change the source's own delivery.
        await sdk.connectWs();
        const mine    = sinon.spy();
        const another = sinon.spy();
        sdk.onMempoolAction(SENDER, mine);
        sdk.onMempoolAction(RECIPIENT, another);

        server._lastClient.send(JSON.stringify(mempoolAction(SENDER, [])));
        await waitForCalls(mine);
        await barrier();

        expect(mine.calledOnce).to.be.true;
        expect(another.called).to.be.false;
    });
});
