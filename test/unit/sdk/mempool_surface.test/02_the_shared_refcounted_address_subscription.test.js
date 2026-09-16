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
    bindMempoolSuite,
    mempoolAction,
    waitAtBarrier,
    waitForCalls
} = require('./support/mempool_surface_support.js');

let server, state, sdk;

function bindContext(context) {
    server = context.server;
    state  = context.state;
    sdk    = context.sdk;
}

async function barrier() {
    await waitAtBarrier(sdk, server);
}

bindMempoolSuite('the shared, refcounted address subscription', bindContext, function () {

    it('opens ONE server subscription and ONE replay entry for two callers', async function () {
        await sdk.connectWs();
        state.reset();

        sdk.onAddress(RECIPIENT, sinon.spy());
        sdk.onMempoolAction(RECIPIENT, sinon.spy());

        const addressSubscribes = () => state.subscribeFrames
            .filter(f => f.channels.includes('address') && f.params.address === RECIPIENT);
        // The barrier is handled after both subscribe frames would have been
        // written to the same socket, so a second one would already be here.
        await barrier();

        expect(addressSubscribes()).to.have.lengthOf(1);
        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('address'))).to.have.lengthOf(1);
    });

    it('leaves the second caller receiving frames after the first tears down', async function () {
        // The headline regression. Without refcounting the first teardown
        // sends the server unsubscribe, the entity-keyed address channel goes
        // away, and the surviving caller stops receiving with no error.
        await sdk.connectWs();
        const confirmed = sinon.spy();
        const pending   = sinon.spy();
        const stopConfirmed = sdk.onAddress(RECIPIENT, confirmed);
        sdk.onMempoolAction(RECIPIENT, pending);
        await barrier();

        stopConfirmed();
        await barrier();

        const delivered = state.emitToAddress(RECIPIENT, mempoolAction(SENDER, [RECIPIENT]));
        expect(delivered, 'the server had already dropped the address channel').to.be.true;
        await waitForCalls(pending);

        expect(pending.calledOnce).to.be.true;
        expect(confirmed.called).to.be.false;
    });
});

bindMempoolSuite('the shared, refcounted address subscription', bindContext, function () {

    it('ignores a teardown called twice instead of releasing another caller', async function () {
        // Against a refcount, a second call on one teardown decrements a
        // holder that is still listening and silently ends SOMEONE ELSE'S
        // delivery. Unbalanced callers are ordinary (a cleanup that also runs
        // on an error path, a component that tears down twice), so every on*
        // teardown is wrapped to release at most once.
        await sdk.connectWs();
        const confirmed = sinon.spy();
        const pending   = sinon.spy();
        const stopConfirmed = sdk.onAddress(RECIPIENT, confirmed);
        sdk.onMempoolAction(RECIPIENT, pending);
        await barrier();

        stopConfirmed();
        stopConfirmed();
        await barrier();

        // The surviving mempool caller must still be subscribed and delivered to.
        expect(state.addressSubs.has(RECIPIENT), 'the second teardown released a holder it did not own').to.be.true;
        const delivered = state.emitToAddress(RECIPIENT, mempoolAction(SENDER, [RECIPIENT]));
        expect(delivered).to.be.true;
        await waitForCalls(pending);
        expect(pending.calledOnce).to.be.true;
    });

    it('sends the server unsubscribe only on the LAST teardown', async function () {
        await sdk.connectWs();
        const stopConfirmed = sdk.onAddress(RECIPIENT, sinon.spy());
        const stopPending   = sdk.onMempoolAction(RECIPIENT, sinon.spy());
        await barrier();
        state.reset();

        // The barrier's own onBlock teardown unsubscribes ['blocks'], so
        // count only the address channel's frames.
        const addressUnsubscribes = () => state.unsubscribeFrames
            .filter(f => f.channels.includes('address') && f.params.address === RECIPIENT);

        stopConfirmed();
        await barrier();
        expect(addressUnsubscribes()).to.have.lengthOf(0);
        expect(state.addressSubs.has(RECIPIENT)).to.be.true;

        stopPending();
        await barrier();
        expect(addressUnsubscribes()).to.have.lengthOf(1);
        expect(state.addressSubs.has(RECIPIENT)).to.be.false;
    });
});

bindMempoolSuite('the shared, refcounted address subscription', bindContext, function () {

    it('replays the channel ONCE on reconnect, not once per caller', async function () {
        await sdk.connectWs();
        sdk.onAddress(RECIPIENT, sinon.spy());
        sdk.onMempoolAction(RECIPIENT, sinon.spy());
        await barrier();
        state.reset();

        sdk.ws._resubscribe();
        await barrier();

        const replayed = state.subscribeFrames
            .filter(f => f.channels.includes('address') && f.params.address === RECIPIENT);
        expect(replayed).to.have.lengthOf(1);
    });

    it('resolves the second subscribe instead of waiting for a SUBSCRIBED that never comes', async function () {
        // The server answers one SUBSCRIBED per subscribe frame. A shared
        // subscribe that waited for its own would hang for the full request
        // timeout, and every onX() caller awaits this promise.
        await sdk.connectWs();
        const first  = await sdk.ws.subscribe(['address'], { address: RECIPIENT });
        const second = await sdk.ws.subscribe(['address'], { address: RECIPIENT });
        expect(first).to.not.be.undefined;
        expect(second).to.equal(first);
    });

    it('keeps a differently-filtered subscription to the same address separate', async function () {
        // The refcount key is (channels, params), which is what
        // unsubscribeBetFeed's exact-params contract depends on: a subscribe
        // carrying a server-side filter is a different subscription, and must
        // not be released by a teardown that never asked for that filter.
        await sdk.connectWs();
        state.reset();

        sdk.onAddress(RECIPIENT, sinon.spy(), { types: ['ORDER_MATCH'] });
        sdk.onMempoolAction(RECIPIENT, sinon.spy());
        await barrier();

        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('address'))).to.have.lengthOf(2);
    });
});
