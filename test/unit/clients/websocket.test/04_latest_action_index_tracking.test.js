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

// latest_action_index from message data
describe('WebSocketClient', function () {
    registerHooks();
    describe('latest_action_index tracking', function () {

        it('updates lastActionIndex from latest_action_index field in message data', async function () {
            client = createClient(port);
            await client.connect();

            server._lastClient.send(JSON.stringify({
                type: 'CATCH_UP_COMPLETE',
                data: { latest_action_index: 999, events_replayed: 5 }
            }));
            await waitFor(() => client.lastActionIndex === '999',
                { message: 'lastActionIndex stayed at ' + client.lastActionIndex });
            expect(client.lastActionIndex).to.equal('999');
        });
    });
});
// send when not connected (no-op)
describe('WebSocketClient', function () {
    registerHooks();
    describe('send when not connected', function () {

        it('does not throw when send called on disconnected ws', function () {
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            // ws is null; should not throw
            expect(() => client.send({ action: 'ping' })).to.not.throw();
        });
    });
});

// WebSocket constructor throw (sync URL error)
describe('WebSocketClient', function () {
    registerHooks();
    describe('WebSocket constructor sync throw', function () {

        it('rejects connect() with WS_CONNECTION_FAILED when URL is invalid', async function () {
            // Force an invalid URL by directly setting baseUrl after construction
            // so the ws library's constructor throws synchronously
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            // Override baseUrl to an empty string so url = 'ws://:port/...' which is invalid
            client.baseUrl = '';
            try {
                await client.connect();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(SDKExplorerError);
                expect(e.code).to.equal('WS_CONNECTION_FAILED');
            }
        });
    });
});

// resubscribe: direct unit test
describe('WebSocketClient', function () {
    registerHooks();
    describe('resubscribe', function () {
        it('sends subscribe messages for all tracked subscriptions', async function () {
            client = createClient(port);
            await client.connect();
            await client.subscribe(['blocks']);
            await client.subscribe(['actions'], { types: ['SEND'] });

            // Track what the server receives
            const received = [];
            server._lastClient.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                received.push(msg);
            });

            // Call resubscribe directly
            client.resubscribe();
            await waitFor(() => received.filter(m => m.action === 'subscribe').length >= 2,
                { message: 'the server never received both replayed subscribes' });

            const subscribeMsgs = received.filter(m => m.action === 'subscribe');
            expect(subscribeMsgs.length).to.be.greaterThanOrEqual(2);
        });

        it('includes since_action_index when lastActionIndex > 0', async function () {
            client = createClient(port);
            await client.connect();
            await client.subscribe(['blocks']);

            // Set lastActionIndex (decimal string, the shape the wire hands us)
            client.lastActionIndex = '500';

            const received = [];
            server._lastClient.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                received.push(msg);
            });

            client.resubscribe();
            await waitFor(() => received.filter(m => m.action === 'subscribe').length >= 1,
                { message: 'the server never received the replayed subscribe' });

            const subscribeMsgs = received.filter(m => m.action === 'subscribe');
            expect(subscribeMsgs[0].params.since_action_index).to.equal('500');
        });
    });
});

describe('WebSocketClient', function () {
    registerHooks();
    describe('resubscribe', function () {
        // The whole point of #4154: the cursor that goes back out on reconnect is the
        // byte-identical index the server sent, not a Number round-trip of it.
        it('replays an above-2^53 cursor byte-for-byte as since_action_index', async function () {
            client = createClient(port);
            await client.connect();
            await client.subscribe(['blocks']);

            client.lastActionIndex = '9007199254740995';

            const received = [];
            server._lastClient.on('message', (data) => {
                received.push(JSON.parse(data.toString()));
            });

            client.resubscribe();
            await waitFor(() => received.filter(m => m.action === 'subscribe').length >= 1,
                { message: 'the server never received the replayed subscribe' });

            const replayed = received.filter(m => m.action === 'subscribe')[0];
            expect(replayed.params.since_action_index).to.equal('9007199254740995');
        });
    });
});
