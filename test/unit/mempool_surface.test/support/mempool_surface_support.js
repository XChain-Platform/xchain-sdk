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

const sinon         = require('sinon');
const WebSocket     = require('ws');
const XChainSDK     = require('../../../../src/XChainSDK.js');
const { waitForCalls } = require('../../../helpers/wait.js');

function welcomeFrame() {
    return {
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
    };
}

function recordMessage(ws, state, data) {
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
}

function attachClient(wss, state, ws) {
    ws.send(JSON.stringify(welcomeFrame()));
    ws.on('message', (data) => recordMessage(ws, state, data));
    wss._lastClient = ws;
}

function attachStateActions(wss, state) {
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
}

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
            wss.on('connection', (ws) => attachClient(wss, state, ws));
            attachStateActions(wss, state);
            resolve({ wss, port, state });
        });
    });
}

// A deterministic barrier for negative assertions: send a frame that IS
// observably handled and wait for it. One socket delivers in order, so once
// the barrier lands, any earlier frame has already been dispatched or
// correctly ignored.
async function waitAtBarrier(sdk, server) {
    const mark = sinon.spy();
    const unsub = sdk.onBlock(mark);
    server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 0 } }));
    await waitForCalls(mark, 1, { message: 'barrier NEW_BLOCK never arrived' });
    unsub();
}

function bindMempoolSuite(title, bindContext, addTests) {
    describe('SDK mempool surface @regression', function () {
        let server, sdk;

        beforeEach(async function () {
            const s = await createMockServer();
            server = s.wss;
            sdk = new XChainSDK({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: s.port
            });
            bindContext({ server, state: s.state, sdk });
        });

        afterEach(function (done) {
            if (sdk) sdk.stop();
            server.close(done);
        });

        describe(title, addTests);
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

module.exports = {
    RECIPIENT,
    SENDER,
    STRANGER,
    XChainSDK,
    bindMempoolSuite,
    mempoolAction,
    mempoolRemoved,
    waitAtBarrier,
    waitForCalls
};
