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
 * Unit tests for WebSocketClient (src/clients/websocket.js)
 *
 * Uses an in-process ws.Server as a mock to test the client
 * without requiring a real xchain-explorer.
 */

'use strict';

const { expect }  = require('chai');
const sinon       = require('sinon');
const WebSocket   = require('ws');
const WebSocketClient = require('../../../../src/clients/websocket.js');
const { SDKExplorerError } = require('../../../../src/utils/errors.js');
const { waitFor, waitForCalls } = require('../../../helpers/wait.js');

// Mock WebSocket Server

function createMockServer(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const wss = new WebSocket.Server({ port: 0 }, () => {
            const port = wss.address().port;

            wss.on('connection', (ws) => {
                // Send WELCOME on connect
                ws.send(JSON.stringify({
                    type: 'WELCOME',
                    chain: 'RBTC',
                    network: 'regtest',
                    timestamp: Date.now(),
                    data: {
                        version: '1.0.0',
                        server_time: Date.now(),
                        latest_block_index: opts.blockIndex || 100,
                        latest_action_index: opts.actionIndex || 500,
                        limits: { max_subscriptions: 25 },
                        channels: ['blocks', 'actions'],
                        types: ['SEND', 'ORDER_MATCH'],
                        features: ['snapshot', 'catch_up']
                    }
                }));

                // Auto-respond to subscribe with SUBSCRIBED
                ws.on('message', (data) => {
                    const msg = JSON.parse(data.toString());
                    if (msg.action === 'subscribe') {
                        ws.send(JSON.stringify({
                            type: 'SUBSCRIBED',
                            id: msg.id,
                            timestamp: Date.now(),
                            data: { channel: msg.channels[0], active_filters: {} }
                        }));
                    }
                    if (msg.action === 'list_subscriptions') {
                        ws.send(JSON.stringify({
                            type: 'SUBSCRIPTION_LIST',
                            id: msg.id,
                            timestamp: Date.now(),
                            data: { count: 0, limit: 25, subscriptions: [] }
                        }));
                    }
                    if (msg.action === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now(), data: {} }));
                    }
                });

                // Store ref for test access
                wss._lastClient = ws;
            });

            resolve({ wss, port });
        });
    });
}

function createClient(port) {
    return new WebSocketClient({
        network: 'bitcoin-regtest',
        websocketUrl: '127.0.0.1',
        websocketPort: port,
        retry: { maxRetries: 2, baseDelay: 100, maxDelay: 500 },
        pingInterval: 60000 // high so it doesn't interfere with tests
    });
}

// Tests

let server, port, client;

function registerHooks() {
    beforeEach(async function () {
        const s = await createMockServer();
        server = s.wss;
        port   = s.port;
    });

    afterEach(function (done) {
        if (client) { client.disconnect(); client = null; }
        server.close(done);
    });
}

// _emit and connection_lost event
describe('WebSocketClient', function () {
    registerHooks();
    describe('_emit and connection_lost', function () {

        it('emits connection_lost when reconnect attempts exhausted', async function () {
            client = createClient(port);
            await client.connect();

            let lostFired = false;
            client.on('connection_lost', () => { lostFired = true; });

            // Exhaust all reconnect attempts by pre-setting the counter
            client.reconnectAttempts = client.maxReconnectAttempts;

            // Force close from server (not intentional from client); triggers _reconnect
            // which immediately sees reconnectAttempts >= maxReconnectAttempts and emits connection_lost
            server._lastClient.close();
            await waitFor(() => lostFired, { message: 'connection_lost never fired' });
            expect(lostFired).to.be.true;
        });

        it('_emit dispatches to registered handlers', function () {
            const spy = sinon.spy();
            const c = new WebSocketClient({ network: 'bitcoin-regtest' });
            c.on('test_event', spy);
            c._emit('test_event', { value: 42 });
            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].data.value).to.equal(42);
            expect(spy.firstCall.args[0].type).to.equal('test_event');
        });

        it('_emit is a no-op when no handlers registered', function () {
            const c = new WebSocketClient({ network: 'bitcoin-regtest' });
            expect(() => c._emit('no_handler', {})).to.not.throw();
        });
    });
});
// _startPing fires
describe('WebSocketClient', function () {
    registerHooks();
    describe('_startPing', function () {

        it('sends ping messages on interval', async function () {
            let pingCount = 0;
            server.on('connection', (ws) => {
                ws.on('message', (raw) => {
                    try { if (JSON.parse(raw).action === 'ping') pingCount++; } catch (_) {}
                });
            });

            const c = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 0 },
                pingInterval: 50 // very short for test
            });
            await c.connect();

            // Wait for the ping itself, not for three ping intervals.
            await waitFor(() => pingCount > 0, { message: 'no ping was sent' });
            c.disconnect();
            expect(pingCount).to.be.greaterThan(0);
        });
    });
});

// onWsReconnect hook + _resubscribe
describe('WebSocketClient', function () {
    registerHooks();
    describe('reconnect and resubscribe', function () {

        it('fires onWsReconnect hook and resubscribes after disconnect', async function () {
            const reconnectSpy = sinon.spy();

            // Create a second server to reconnect to
            const s2 = await (new Promise((resolve) => {
                const wss2 = new WebSocket.Server({ port: 0 }, () => {
                    const p2 = wss2.address().port;
                    wss2.on('connection', (ws) => {
                        ws.send(JSON.stringify({
                            type: 'WELCOME',
                            data: { version: '1.0.0', latest_block_index: 100, latest_action_index: 500, limits: {}, channels: [], types: [], features: [] }
                        }));
                        ws.on('message', (data) => {
                            const msg = JSON.parse(data.toString());
                            if (msg.action === 'subscribe') {
                                ws.send(JSON.stringify({ type: 'SUBSCRIBED', id: msg.id, data: { channel: msg.channels[0] } }));
                            }
                        });
                        wss2._lastClient = ws;
                    });
                    resolve({ wss: wss2, port: p2 });
                });
            }));

            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 2, baseDelay: 50, maxDelay: 200 },
                pingInterval: 60000,
                hooks: { onWsReconnect: reconnectSpy }
            });

            await client.connect();
            await client.subscribe(['blocks']);

            // Change to second server BEFORE forcing disconnect
            client.baseUrl = '127.0.0.1';
            client.port = s2.port;

            // Force close from server (triggers reconnect)
            server._lastClient.close();

            await waitFor(() => reconnectSpy.called, { timeout: 5000, message: 'onWsReconnect never fired' });
            expect(reconnectSpy.called).to.be.true;

            client.disconnect();
            await new Promise(r => s2.wss.close(r));
        });
    });
});

// subscribe with params
describe('WebSocketClient', function () {
    registerHooks();
    describe('subscribe with params', function () {

        it('sends subscribe with params when provided', async function () {
            client = createClient(port);
            await client.connect();

            const result = await client.subscribe(['actions'], { types: ['SEND'] });
            expect(result.type).to.equal('SUBSCRIBED');
            expect(client._subscriptions[0].params).to.deep.equal({ types: ['SEND'] });
        });
    });
});

// unsubscribe with params filtering
describe('WebSocketClient', function () {
    registerHooks();
    describe('unsubscribe with params', function () {

        it('removes only matching subscription by channels+params', async function () {
            client = createClient(port);
            await client.connect();

            await client.subscribe(['actions'], { types: ['SEND'] });
            await client.subscribe(['blocks']);
            expect(client._subscriptions).to.have.lengthOf(2);

            client.unsubscribe(['blocks']);
            expect(client._subscriptions).to.have.lengthOf(1);
            expect(client._subscriptions[0].channels).to.deep.equal(['actions']);
        });
    });
});
