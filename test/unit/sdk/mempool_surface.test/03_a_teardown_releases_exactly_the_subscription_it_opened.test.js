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

// ws.unsubscribe matches the tracked replay entry on the exact
// (channels, params) pair, so a helper that subscribes with one shape and
// tears down with another releases nothing at all: the refcount never
// reaches zero, the server keeps sending on a channel nobody is listening
// to, and the entry replays that channel on every reconnect for the life
// of the client. Every assertion below is on OBSERVABLE traffic (a frame
// the mock explorer received, a channel it still considers open) rather
// than on the client's own bookkeeping.

const addressUnsubscribes = () => state.unsubscribeFrames
    .filter(f => f.channels.includes('address') && f.params.address === RECIPIENT);
const addressSubscribes = () => state.subscribeFrames
    .filter(f => f.channels.includes('address') && f.params.address === RECIPIENT);
const trackedAddress = () => sdk.ws._subscriptions.filter(s => s.channels.includes('address'));

bindMempoolSuite('a teardown releases exactly the subscription it opened', bindContext, function () {

    it('sends the server unsubscribe for a types-filtered address helper', async function () {
        await sdk.connectWs();
        const stop = sdk.onCoinpayRequired(RECIPIENT, sinon.spy());
        await barrier();
        expect(state.addressSubs.has(RECIPIENT), 'the subscribe never reached the server').to.be.true;
        state.reset();

        stop();
        await barrier();

        expect(addressUnsubscribes(), 'the teardown sent no unsubscribe frame').to.have.lengthOf(1);
        expect(state.addressSubs.has(RECIPIENT), 'the server still has the channel open').to.be.false;
        expect(trackedAddress(), 'a replay entry survived the teardown').to.have.lengthOf(0);
    });

    it('releases onAddress itself when it was opened with a types filter', async function () {
        // onAddress is the helper the wallet actually holds open per address,
        // so it is the one that matters most here. With no opts its params are
        // bare { address } and a rebuilt teardown happens to match, which is
        // why this case has to be asserted with a filter present.
        await sdk.connectWs();
        const stop = sdk.onAddress(RECIPIENT, sinon.spy(), { types: ['NEW_ACTION'] });
        await barrier();
        expect(state.addressSubs.has(RECIPIENT)).to.be.true;
        state.reset();

        stop();
        await barrier();

        expect(addressUnsubscribes(), 'the teardown sent no unsubscribe frame').to.have.lengthOf(1);
        expect(state.addressSubs.has(RECIPIENT), 'the server still has the channel open').to.be.false;
        expect(trackedAddress(), 'a replay entry survived the teardown').to.have.lengthOf(0);
    });

    it('releases onAddress itself when it was opened with a snapshot request', async function () {
        await sdk.connectWs();
        const stop = sdk.onAddress(RECIPIENT, sinon.spy(), { snapshot: true });
        await barrier();
        state.reset();

        stop();
        await barrier();

        expect(addressUnsubscribes()).to.have.lengthOf(1);
        expect(trackedAddress(), 'a replay entry survived the teardown').to.have.lengthOf(0);
    });
});

bindMempoolSuite('a teardown releases exactly the subscription it opened', bindContext, function () {

    it('does not replay a torn-down types-filtered channel on reconnect', async function () {
        await sdk.connectWs();
        const stop = sdk.onOrderMatch(RECIPIENT, sinon.spy());
        await barrier();

        stop();
        await barrier();
        state.reset();

        sdk.ws.resubscribe();
        await barrier();

        expect(addressSubscribes(), 'the address channel came back on reconnect').to.have.lengthOf(0);
        expect(state.addressSubs.has(RECIPIENT)).to.be.false;
    });

    it('shares one subscription between two identically-filtered helpers', async function () {
        await sdk.connectWs();
        state.reset();

        const first  = sinon.spy();
        const second = sinon.spy();
        const stopFirst  = sdk.onOrderMatch(RECIPIENT, first);
        const stopSecond = sdk.onOrderMatch(RECIPIENT, second);
        await barrier();

        expect(addressSubscribes(), 'the second helper opened its own subscription').to.have.lengthOf(1);
        state.reset();

        stopFirst();
        await barrier();
        expect(addressUnsubscribes(), 'the first teardown ended the survivor\'s delivery').to.have.lengthOf(0);
        expect(state.addressSubs.has(RECIPIENT)).to.be.true;

        // The survivor is still delivered to, which is the point of the
        // shared refcount rather than a count matching.
        const delivered = state.emitToAddress(RECIPIENT, {
            type: 'ORDER_MATCH', chain: 'BTC', network: 'regtest',
            timestamp: Date.now(), data: { address: RECIPIENT, action_index: '9' }
        });
        expect(delivered).to.be.true;
        await waitForCalls(second);
        expect(second.calledOnce).to.be.true;
        expect(first.called).to.be.false;

        stopSecond();
        await barrier();
        expect(addressUnsubscribes(), 'the last teardown never reached the server').to.have.lengthOf(1);
        expect(state.addressSubs.has(RECIPIENT)).to.be.false;
        expect(trackedAddress()).to.have.lengthOf(0);
    });
});

bindMempoolSuite('a teardown releases exactly the subscription it opened', bindContext, function () {

    it('releases a snapshot-shaped entity helper', async function () {
        // `snapshot: true` rides in the subscribe params, so it is part of the
        // subscription's identity exactly as a types filter is.
        await sdk.connectWs();
        const stop = sdk.onBetFeed('42', sinon.spy());
        await barrier();
        state.reset();

        stop();
        await barrier();

        const released = state.unsubscribeFrames.filter(f => f.channels.includes('bet_feed'));
        expect(released, 'the teardown sent no unsubscribe frame').to.have.lengthOf(1);
        expect(released[0].params.action_index).to.equal('42');
        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('bet_feed'))).to.have.lengthOf(0);
    });

    it('releases the xcall helper and sends the id lower-cased', async function () {
        // Two contracts in one run, because both are silent when broken: the
        // explorer lower-cases at subscribe time, so an upper-case id would
        // hold a live subscription that receives nothing, and a teardown that
        // rebuilt the params in another shape would release nothing at all.
        const CALL_ID = 'a1b2c3d4'.repeat(8);
        await sdk.connectWs();
        const stop = sdk.onXcall(CALL_ID.toUpperCase(), sinon.spy());
        await barrier();

        const opened = state.subscribeFrames.filter(f => f.channels.includes('xcall'));
        expect(opened, 'the subscribe never reached the server').to.have.lengthOf(1);
        expect(opened[0].params.call_id).to.equal(CALL_ID);
        state.reset();

        stop();
        await barrier();

        const released = state.unsubscribeFrames.filter(f => f.channels.includes('xcall'));
        expect(released, 'the teardown sent no unsubscribe frame').to.have.lengthOf(1);
        expect(released[0].params.call_id).to.equal(CALL_ID);
        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('xcall'))).to.have.lengthOf(0);
    });

    it('releases a filtered global channel', async function () {
        await sdk.connectWs();
        const stop = sdk.onAction(sinon.spy(), { types: ['SEND'] });
        await barrier();
        state.reset();

        stop();
        await barrier();

        expect(state.unsubscribeFrames.filter(f => f.channels.includes('actions'))).to.have.lengthOf(1);
        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('actions'))).to.have.lengthOf(0);
    });
});

bindMempoolSuite('a teardown releases exactly the subscription it opened', bindContext, function () {

    it('pairs subscribeBetFeed with unsubscribeBetFeed', async function () {
        // Both build their params the same way, and that identity is what
        // releases the entry. A divergence here is invisible until a reconnect
        // re-subscribes a market nobody is watching.
        await sdk.connectWs();
        await sdk.ws.subscribeBetFeed(7, { snapshot: true });
        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('bet_feed'))).to.have.lengthOf(1);
        state.reset();

        sdk.ws.unsubscribeBetFeed(7, { snapshot: true });
        await barrier();

        const released = state.unsubscribeFrames.filter(f => f.channels.includes('bet_feed'));
        expect(released, 'the pair did not release the tracked entry').to.have.lengthOf(1);
        expect(released[0].params.action_index).to.equal('7');
        expect(sdk.ws._subscriptions.filter(s => s.channels.includes('bet_feed'))).to.have.lengthOf(0);
    });
});
