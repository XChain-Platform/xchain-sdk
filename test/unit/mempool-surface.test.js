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

const { expect }    = require('chai');
const sinon         = require('sinon');
const WebSocket     = require('ws');
const XChainSDK     = require('../../src/XChainSDK.js');
const { waitForCalls } = require('../helpers/wait.js');

// A mock explorer WebSocket that keeps the address channel ENTITY-KEYED, the way
// the real ChannelManager does: one subscription per (client, channel, address),
// and an unsubscribe for that address stops delivery on it. Frames sent through
// emitToAddress() are therefore only delivered while a subscription is live,
// which is what makes the mutual-destruction test a real one.
function createMockServer() {
    return new Promise((resolve) => {
        const state = {
            subscribeFrames:   [],
            unsubscribeFrames: [],
            addressSubs:       new Set()
        };

        const wss = new WebSocket.Server({ port: 0 }, () => {
            const port = wss.address().port;

            wss.on('connection', (ws) => {
                ws.send(JSON.stringify({
                    type: 'WELCOME',
                    chain: 'BTC',
                    network: 'regtest',
                    timestamp: Date.now(),
                    data: {
                        version: '1.0.0',
                        server_time: Date.now(),
                        latest_block_index: 100,
                        latest_action_index: 500,
                        limits: { max_subscriptions: 25 },
                        channels: ['blocks', 'actions', 'address', 'mempool'],
                        types: [],
                        features: []
                    }
                }));

                ws.on('message', (data) => {
                    const msg = JSON.parse(data.toString());
                    const params = msg.params || {};
                    if (msg.action === 'subscribe') {
                        state.subscribeFrames.push({ channels: msg.channels, params });
                        if (msg.channels.includes('address') && params.address)
                            state.addressSubs.add(params.address);
                        ws.send(JSON.stringify({
                            type: 'SUBSCRIBED',
                            id: msg.id,
                            timestamp: Date.now(),
                            data: { channel: msg.channels[0], active_filters: {} }
                        }));
                    }
                    if (msg.action === 'unsubscribe') {
                        state.unsubscribeFrames.push({ channels: msg.channels, params });
                        if (msg.channels.includes('address') && params.address)
                            state.addressSubs.delete(params.address);
                    }
                });

                wss._lastClient = ws;
            });

            // Deliver a frame on ONE address's channel, only while that channel
            // is actually subscribed.
            state.emitToAddress = (address, frame) => {
                if (!state.addressSubs.has(address)) return false;
                wss._lastClient.send(JSON.stringify(frame));
                return true;
            };
            state.reset = () => {
                state.subscribeFrames.length   = 0;
                state.unsubscribeFrames.length = 0;
            };

            resolve({ wss, port, state });
        });
    });
}

// One MEMPOOL_ACTION as the explorer emits it on an ADDRESS channel.
function mempoolAction(source, destinations) {
    const data = {
        tx_hash: 'aa11',
        source,
        action: 'SEND',
        data: 'SEND|3|XCHAIN|100000000|^350',
        first_seen: 1756300000
    };
    if (destinations !== undefined) data.destinations = destinations;
    return { type: 'MEMPOOL_ACTION', chain: 'BTC', network: 'regtest', timestamp: Date.now(), data };
}

function mempoolRemoved(source, destinations) {
    const data = { tx_hash: 'aa11', source };
    if (destinations !== undefined) data.destinations = destinations;
    return { type: 'MEMPOOL_REMOVED', chain: 'BTC', network: 'regtest', timestamp: Date.now(), data };
}

const SENDER    = '1sender';
const RECIPIENT = '1recipient';
const STRANGER  = '1stranger';


describe('SDK mempool surface @regression', function () {

    let server, port, state, sdk;

    beforeEach(async function () {
        const s = await createMockServer();
        server = s.wss;
        port   = s.port;
        state  = s.state;

        sdk = new XChainSDK({
            network: 'bitcoin-regtest',
            websocketUrl: '127.0.0.1',
            websocketPort: port
        });
    });

    afterEach(function (done) {
        if (sdk) sdk.stop();
        server.close(done);
    });

    // A deterministic barrier for negative assertions: send a frame that IS
    // observably handled and wait for it. One socket delivers in order, so once
    // the barrier lands, any earlier frame has already been dispatched or
    // correctly ignored.
    async function barrier() {
        const mark = sinon.spy();
        const unsub = sdk.onBlock(mark);
        server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 0 } }));
        await waitForCalls(mark, 1, { message: 'barrier NEW_BLOCK never arrived' });
        unsub();
    }


    describe('the roster', function () {

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


    describe('the per-address guard', function () {

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


    describe('the shared, refcounted address subscription', function () {

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


    describe('a teardown releases exactly the subscription it opened', function () {

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

        it('does not replay a torn-down types-filtered channel on reconnect', async function () {
            await sdk.connectWs();
            const stop = sdk.onOrderMatch(RECIPIENT, sinon.spy());
            await barrier();

            stop();
            await barrier();
            state.reset();

            sdk.ws._resubscribe();
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


    describe('getUnconfirmed', function () {

        function sdkWithMempool(rows, capture) {
            const s = Object.create(XChainSDK.prototype);
            s.explorer = {
                async getMempool(query, type, opts) {
                    if (capture) capture.push({ query, type, opts });
                    return rows;
                }
            };
            return s;
        }

        it('returns the explorer field names verbatim, plus destinations', async function () {
            const s = sdkWithMempool({ data: [{
                tx_hash: 'aa11', source: SENDER, action: 'SEND',
                data: 'SEND|3|XCHAIN|100000000|^350', first_seen: 1756300000
            }], total: 1 });

            const rows = await s.getUnconfirmed(RECIPIENT);

            expect(rows).to.have.lengthOf(1);
            expect(rows[0]).to.deep.equal({
                tx_hash: 'aa11',
                source: SENDER,
                action: 'SEND',
                data: 'SEND|3|XCHAIN|100000000|^350',
                first_seen: 1756300000,
                destinations: [RECIPIENT]
            });
        });

        it('leaves destinations empty for the address\'s own transaction', async function () {
            const s = sdkWithMempool({ data: [{
                tx_hash: 'bb22', source: SENDER, action: 'SEND', data: 'SEND|3|XCHAIN|1|^350',
                first_seen: null
            }] });

            const rows = await s.getUnconfirmed(SENDER);

            expect(rows[0].destinations).to.deep.equal([]);
            expect(rows[0].first_seen).to.equal(null);
        });

        it('defaults the limit to 100 and lets a caller override it', async function () {
            const capture = [];
            const s = sdkWithMempool({ data: [] }, capture);

            await s.getUnconfirmed(RECIPIENT);
            await s.getUnconfirmed(RECIPIENT, { limit: 25 });

            expect(capture[0].type).to.equal('address');
            expect(capture[0].query).to.equal(RECIPIENT);
            expect(capture[0].opts.limit).to.equal(100);
            expect(capture[1].opts.limit).to.equal(25);
        });

        it('returns [] on an empty mempool rather than null or a throw', async function () {
            expect(await sdkWithMempool({ data: [], total: 0 }).getUnconfirmed(RECIPIENT)).to.deep.equal([]);
            // An envelope with no data key at all (an explorer that answered
            // something unexpected) must degrade the same way.
            expect(await sdkWithMempool({}).getUnconfirmed(RECIPIENT)).to.deep.equal([]);
            expect(await sdkWithMempool(null).getUnconfirmed(RECIPIENT)).to.deep.equal([]);
        });
    });
});
