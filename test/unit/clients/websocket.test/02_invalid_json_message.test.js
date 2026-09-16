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

// HTTP base URL → ws scheme conversion
describe('WebSocketClient', function () {
    registerHooks();
    describe('http(s) base URL scheme conversion', function () {

        it('converts http://host URL to ws://host/COIN/api/websocket', async function () {
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: 'http://127.0.0.1:' + port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            await client.connect();
            expect(client.isConnected()).to.be.true;
        });
    });
});
// Invalid JSON message (silent skip)
describe('WebSocketClient', function () {
    registerHooks();
    describe('invalid JSON message', function () {

        it('does not throw on invalid JSON from server', async function () {
            client = createClient(port);
            await client.connect();

            // Send garbage data; should be silently ignored
            server._lastClient.send('not valid json!!');
            // A well-formed frame BEHIND the garbage: once it is handled the
            // garbage has already been through the parser, in order, on one socket.
            const after = sinon.spy();
            client.on('NEW_BLOCK', after);
            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: {} }));
            await waitForCalls(after, 1, { message: 'the frame behind the garbage never arrived' });
            // Client should still be connected
            expect(client.isConnected()).to.be.true;
        });
    });
});

// onWsDisconnect hook
describe('WebSocketClient', function () {
    registerHooks();
    describe('onWsDisconnect hook', function () {

        it('fires onWsDisconnect when connection closes', async function () {
            const disconnectSpy = sinon.spy();
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                hooks: { onWsDisconnect: disconnectSpy },
                retry: { maxRetries: 0, baseDelay: 0 },
                pingInterval: 60000
            });
            await client.connect();
            client.disconnect();
            await waitFor(() => disconnectSpy.called, { message: 'onWsDisconnect never fired' });
            expect(disconnectSpy.called).to.be.true;
        });
    });
});

// setBase
describe('WebSocketClient', function () {
    registerHooks();
    describe('setBase', function () {
        it('no-ops when both url and port are falsy', async function () {
            client = createClient(port);
            await client.connect();
            const origUrl = client.baseUrl;
            client.setBase(null, null);
            expect(client.baseUrl).to.equal(origUrl);
        });

        it('no-ops when url/port unchanged', async function () {
            client = createClient(port);
            await client.connect();
            const origUrl = client.baseUrl;
            client.setBase('127.0.0.1', port);
            expect(client.baseUrl).to.equal(origUrl);
        });

        it('updates baseUrl/port when values change (not connected)', function () {
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            client.setBase('new-host.test', 9999);
            expect(client.baseUrl).to.equal('new-host.test');
            expect(client.port).to.equal(9999);
        });
    });
});

describe('WebSocketClient', function () {
    registerHooks();
    describe('setBase', function () {
        it('disconnects and reconnects when base changes while connected', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.isConnected()).to.be.true;

            // Create another mock server on a different port
            const s2 = await (new Promise((resolve) => {
                const wss2 = new WebSocket.Server({ port: 0 }, () => {
                    const p2 = wss2.address().port;
                    wss2.on('connection', (ws) => {
                        ws.send(JSON.stringify({
                            type: 'WELCOME',
                            data: { version: '2.0.0', latest_block_index: 200, latest_action_index: 600, limits: {}, channels: [], types: [], features: [] }
                        }));
                        wss2._lastClient = ws;
                    });
                    resolve({ wss: wss2, port: p2 });
                });
            }));

            // setBase while connected should trigger disconnect + reconnect
            client.setBase('127.0.0.1', s2.port);
            // Wait for the client to actually land on the second server, which is
            // the thing this test is about; the old fixed 300ms asserted nothing.
            await waitFor(() => !!s2.wss._lastClient, { message: 'client never reconnected to the second server' });
            s2.wss.close();
        });
    });
});

// _sendWithResponse timeout
describe('WebSocketClient', function () {
    registerHooks();
    describe('_sendWithResponse timeout', function () {

        it('rejects with WS_TIMEOUT when server does not respond', async function () {
            client = createClient(port);
            await client.connect();

            // Send a message that the server won't respond to (use a short timeout)
            try {
                await client._sendWithResponse('test-id-999', { action: 'unknown' }, 100);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(SDKExplorerError);
                expect(e.code).to.equal('WS_TIMEOUT');
            }
        });
    });
});

// _rejectAllPending: rejects pending on disconnect
describe('WebSocketClient', function () {
    registerHooks();
    describe('_rejectAllPending', function () {

        it('rejects pending request-responses when disconnect() is called', async function () {
            client = createClient(port);
            await client.connect();

            // Start a long request that won't complete
            let rejected = false;
            const p = client._sendWithResponse('pending-id', { action: 'noreply' }, 10000)
                .catch((e) => { rejected = true; });

            // Disconnect while request is pending
            client.disconnect();
            await p;
            expect(rejected).to.be.true;
        });
    });
});

// Pending response error type
describe('WebSocketClient', function () {
    registerHooks();
    describe('pending response with error type', function () {

        it('rejects pending request when server responds with error type', async function () {
            client = createClient(port);
            await client.connect();

            const id = 'myreq-1';
            const p = client._sendWithResponse(id, { action: 'test', id }, 5000);

            // _sendWithResponse registers _pending[id] synchronously inside its
            // Promise executor, so the only precondition is that registration,
            // not an elapsed duration.
            await waitFor(() => client._pending[id] !== undefined, { message: 'request was never registered as pending' });
            // Server sends an error response with the same id
            server._lastClient.send(JSON.stringify({
                type: 'error',
                id,
                data: { code: 'SOME_ERROR', message: 'test error' }
            }));

            try {
                await p;
                expect.fail('should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(SDKExplorerError);
                expect(e.code).to.equal('SOME_ERROR');
            }
        });
    });
});

// _onMessage WELCOME when lastActionIndex = 0
describe('WebSocketClient', function () {
    registerHooks();
    describe('WELCOME with lastActionIndex=0', function () {

        it('seeds lastActionIndex from WELCOME latest_action_index when starting at 0', async function () {
            const s = await createMockServer({ actionIndex: 777 });
            const c = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: s.port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            await c.connect();
            expect(c.lastActionIndex).to.equal('777');
            c.disconnect();
            await new Promise(r => s.wss.close(r));
        });

        // The "0" guard from the original coercion: a chain sitting at index 0 sends
        // the string "0", which is truthy. It must seed the cursor without producing a
        // since_action_index on the next subscribe (#4154 must not regress this).
        it('a WELCOME of "0" seeds the cursor but sends no since_action_index', async function () {
            const s = await createMockServer({ actionIndex: '0' });
            const c = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: s.port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            await c.connect();
            expect(c.lastActionIndex).to.equal('0');

            const sent = [];
            c._send = (m) => sent.push(m);
            c._subscriptions = [{ channels: ['blocks'], params: {} }];
            c._resubscribe();

            expect(sent).to.have.lengthOf(1);
            expect(sent[0].params).to.not.have.property('since_action_index');
            c.disconnect();
            await new Promise(r => s.wss.close(r));
        });
    });
});
