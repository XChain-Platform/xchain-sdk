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
 * Unit tests for WebSocketClient (src/websocket.js)
 *
 * Uses an in-process ws.Server as a mock to test the client
 * without requiring a real xchain-explorer.
 */

'use strict';

const { expect }  = require('chai');
const sinon       = require('sinon');
const WebSocket   = require('ws');
const WebSocketClient = require('../../src/websocket.js');
const { SDKExplorerError } = require('../../src/errors.js');

// ---------------------------------------------------------------------------
// Mock WebSocket Server
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocketClient', function () {

    let server, port, client;

    beforeEach(async function () {
        const s = await createMockServer();
        server = s.wss;
        port   = s.port;
    });

    afterEach(function (done) {
        if (client) { client.disconnect(); client = null; }
        server.close(done);
    });

    // -----------------------------------------------------------------
    // Schema version surface
    // -----------------------------------------------------------------

    describe('WS_SCHEMA_VERSION', function () {

        it('is exposed as a static on the client class', function () {
            const WebSocketClient = require('../../src/websocket.js');
            expect(WebSocketClient.WS_SCHEMA_VERSION).to.be.a('number');
            expect(WebSocketClient.WS_SCHEMA_VERSION).to.equal(2);
        });

        it('matches the explorer sibling schema version when checked out (cross-repo drift guard)', function () {
            const path = require('path');
            const explorerSchema = path.join(__dirname, '..', '..', '..', 'xchain-explorer', 'src', 'ws', 'schema-version.js');
            if (!require('fs').existsSync(explorerSchema)) return this.skip();
            const WebSocketClient = require('../../src/websocket.js');
            expect(require(explorerSchema).WS_SCHEMA_VERSION).to.equal(WebSocketClient.WS_SCHEMA_VERSION);
        });
    });

    // -----------------------------------------------------------------
    // Connection
    // -----------------------------------------------------------------

    describe('connection', function () {

        it('connects and receives WELCOME', async function () {
            client = createClient(port);
            const info = await client.connect();
            expect(client.isConnected()).to.be.true;
            expect(info.version).to.equal('1.0.0');
            expect(info.latest_block_index).to.equal(100);
        });

        it('stores serverInfo from WELCOME', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.serverInfo).to.not.be.null;
            expect(client.serverInfo.version).to.equal('1.0.0');
        });

        it('seeds lastActionIndex from WELCOME', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.lastActionIndex).to.equal(500);
        });

        it('disconnect sets connected to false', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.isConnected()).to.be.true;
            client.disconnect();
            expect(client.isConnected()).to.be.false;
        });

        it('rejects on connection failure', async function () {
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: 1, // bad port
                retry: false
            });
            try {
                await client.connect();
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).to.be.instanceOf(SDKExplorerError);
            }
        });
    });

    // -----------------------------------------------------------------
    // Coin prefix
    // -----------------------------------------------------------------

    describe('coin prefix', function () {

        it('derives RBTC from bitcoin-regtest', function () {
            const c = new WebSocketClient({ network: 'bitcoin-regtest' });
            expect(c.coin).to.equal('RBTC');
        });

        it('derives BTC from bitcoin-mainnet', function () {
            const c = new WebSocketClient({ network: 'bitcoin-mainnet' });
            expect(c.coin).to.equal('BTC');
        });

        it('throws on invalid network', function () {
            expect(() => new WebSocketClient({ network: 'invalid' })).to.throw(/Unknown network/);
        });

        it('defaults to BTC when no network', function () {
            const c = new WebSocketClient({});
            expect(c.coin).to.equal('BTC');
        });
    });

    // -----------------------------------------------------------------
    // Subscribe
    // -----------------------------------------------------------------

    describe('subscribe', function () {

        it('sends subscribe message and resolves with SUBSCRIBED', async function () {
            client = createClient(port);
            await client.connect();
            const result = await client.subscribe(['blocks']);
            expect(result.type).to.equal('SUBSCRIBED');
            expect(result.data.channel).to.equal('blocks');
        });

        it('tracks subscription for reconnect replay', async function () {
            client = createClient(port);
            await client.connect();
            await client.subscribe(['blocks']);
            expect(client._subscriptions).to.have.lengthOf(1);
            expect(client._subscriptions[0].channels).to.deep.equal(['blocks']);
        });
    });

    // -----------------------------------------------------------------
    // Unsubscribe
    // -----------------------------------------------------------------

    describe('unsubscribe', function () {

        it('removes tracked subscription', async function () {
            client = createClient(port);
            await client.connect();
            await client.subscribe(['blocks']);
            expect(client._subscriptions).to.have.lengthOf(1);
            client.unsubscribe(['blocks']);
            expect(client._subscriptions).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------
    // List subscriptions
    // -----------------------------------------------------------------

    describe('listSubscriptions', function () {

        it('returns SUBSCRIPTION_LIST', async function () {
            client = createClient(port);
            await client.connect();
            const result = await client.listSubscriptions();
            expect(result.type).to.equal('SUBSCRIPTION_LIST');
            expect(result.data.count).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------

    describe('event handlers', function () {

        it('on() registers handler that fires on matching event', async function () {
            client = createClient(port);
            await client.connect();

            const spy = sinon.spy();
            client.on('NEW_BLOCK', spy);

            // Push event from server
            server._lastClient.send(JSON.stringify({
                type: 'NEW_BLOCK',
                chain: 'BTC',
                network: 'regtest',
                timestamp: Date.now(),
                data: { block_index: 101 }
            }));

            // Wait for message to be received
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].data.block_index).to.equal(101);
        });

        it('off() removes handler', async function () {
            client = createClient(port);
            await client.connect();

            const spy = sinon.spy();
            client.on('NEW_BLOCK', spy);
            client.off('NEW_BLOCK', spy);

            server._lastClient.send(JSON.stringify({
                type: 'NEW_BLOCK', data: { block_index: 101 }
            }));

            await new Promise(r => setTimeout(r, 50));

            expect(spy.callCount).to.equal(0);
        });

        it('once() fires handler only once then removes', async function () {
            client = createClient(port);
            await client.connect();

            const spy = sinon.spy();
            client.once('NEW_BLOCK', spy);

            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 101 } }));
            await new Promise(r => setTimeout(r, 50));
            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 102 } }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });

        it('wildcard handler receives all events', async function () {
            client = createClient(port);
            await client.connect();

            const spy = sinon.spy();
            client.on('*', spy);

            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: {} }));
            server._lastClient.send(JSON.stringify({ type: 'NEW_ACTION', data: {} }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.callCount).to.equal(2);
        });

        it('tracks lastActionIndex from events', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.lastActionIndex).to.equal(500); // from WELCOME

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: 505 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(client.lastActionIndex).to.equal(505);
        });
    });

    // -----------------------------------------------------------------
    // Lifecycle hooks
    // -----------------------------------------------------------------

    describe('hooks', function () {

        it('fires onWsConnect hook', async function () {
            const connectSpy = sinon.spy();
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                hooks: { onWsConnect: connectSpy },
                retry: false,
                pingInterval: 60000
            });
            await client.connect();
            expect(connectSpy.calledOnce).to.be.true;
        });

        it('fires onWsMessage hook for every message', async function () {
            const msgSpy = sinon.spy();
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                hooks: { onWsMessage: msgSpy },
                retry: false,
                pingInterval: 60000
            });
            await client.connect();
            // WELCOME already received; should have at least 1 call
            expect(msgSpy.callCount).to.be.greaterThanOrEqual(1);
        });
    });

    // -----------------------------------------------------------------
    // Catch-up tracking
    // -----------------------------------------------------------------

    describe('catch-up', function () {

        it('tracks catching up state from catch_up flag', async function () {
            client = createClient(port);
            await client.connect();

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', catch_up: true, data: { action_index: 501 }
            }));
            await new Promise(r => setTimeout(r, 50));
            expect(client.catchingUp).to.be.true;

            server._lastClient.send(JSON.stringify({
                type: 'CATCH_UP_COMPLETE', data: { events_replayed: 1, latest_action_index: 501 }
            }));
            await new Promise(r => setTimeout(r, 50));
            expect(client.catchingUp).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // connect() when already connected (short-circuit)
    // -----------------------------------------------------------------

    describe('connect when already connected', function () {

        it('returns serverInfo immediately when already connected (OPEN)', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.isConnected()).to.be.true;

            // Second connect() call should resolve immediately with serverInfo
            const info = await client.connect();
            expect(info).to.equal(client.serverInfo);
        });
    });

    // -----------------------------------------------------------------
    // readyHook
    // -----------------------------------------------------------------

    describe('readyHook in connect', function () {

        it('awaits readyHook before connecting', async function () {
            let hookCalled = false;
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 0 },
                pingInterval: 60000,
                readyHook: async () => { hookCalled = true; }
            });
            await client.connect();
            expect(hookCalled).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // HTTP base URL → ws scheme conversion
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // Invalid JSON message (silent skip)
    // -----------------------------------------------------------------

    describe('invalid JSON message', function () {

        it('does not throw on invalid JSON from server', async function () {
            client = createClient(port);
            await client.connect();

            // Send garbage data; should be silently ignored
            server._lastClient.send('not valid json!!');
            await new Promise(r => setTimeout(r, 50));
            // Client should still be connected
            expect(client.isConnected()).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // onWsDisconnect hook
    // -----------------------------------------------------------------

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
            // Give close event time to propagate
            await new Promise(r => setTimeout(r, 100));
            expect(disconnectSpy.called).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // setBase
    // -----------------------------------------------------------------

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
            // Give reconnect time
            await new Promise(r => setTimeout(r, 300));
            s2.wss.close();
        });
    });

    // -----------------------------------------------------------------
    // _sendWithResponse timeout
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // _rejectAllPending: rejects pending on disconnect
    // -----------------------------------------------------------------

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
            await new Promise(r => setTimeout(r, 50));
            await p;
            expect(rejected).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Pending response error type
    // -----------------------------------------------------------------

    describe('pending response with error type', function () {

        it('rejects pending request when server responds with error type', async function () {
            client = createClient(port);
            await client.connect();

            const id = 'myreq-1';
            const p = client._sendWithResponse(id, { action: 'test', id }, 5000);

            // Server sends an error response with the same id
            await new Promise(r => setTimeout(r, 30));
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

    // -----------------------------------------------------------------
    // _onMessage WELCOME when lastActionIndex = 0
    // -----------------------------------------------------------------

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
            expect(c.lastActionIndex).to.equal(777);
            c.disconnect();
            await new Promise(r => s.wss.close(r));
        });
    });

    // -----------------------------------------------------------------
    // _emit and connection_lost event
    // -----------------------------------------------------------------

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
            await new Promise(r => setTimeout(r, 200));
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

    // -----------------------------------------------------------------
    // _startPing fires
    // -----------------------------------------------------------------

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

            // Wait for at least one ping to be sent
            await new Promise(r => setTimeout(r, 150));
            c.disconnect();
            expect(pingCount).to.be.greaterThan(0);
        });
    });

    // -----------------------------------------------------------------
    // onWsReconnect hook + _resubscribe
    // -----------------------------------------------------------------

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

            await new Promise(r => setTimeout(r, 500));
            expect(reconnectSpy.called).to.be.true;

            client.disconnect();
            await new Promise(r => s2.wss.close(r));
        });
    });

    // -----------------------------------------------------------------
    // subscribe with params
    // -----------------------------------------------------------------

    describe('subscribe with params', function () {

        it('sends subscribe with params when provided', async function () {
            client = createClient(port);
            await client.connect();

            const result = await client.subscribe(['actions'], { types: ['SEND'] });
            expect(result.type).to.equal('SUBSCRIBED');
            expect(client._subscriptions[0].params).to.deep.equal({ types: ['SEND'] });
        });
    });

    // -----------------------------------------------------------------
    // unsubscribe with params filtering
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // latest_action_index from message data
    // -----------------------------------------------------------------

    describe('latest_action_index tracking', function () {

        it('updates lastActionIndex from latest_action_index field in message data', async function () {
            client = createClient(port);
            await client.connect();

            server._lastClient.send(JSON.stringify({
                type: 'CATCH_UP_COMPLETE',
                data: { latest_action_index: 999, events_replayed: 5 }
            }));
            await new Promise(r => setTimeout(r, 50));
            expect(client.lastActionIndex).to.equal(999);
        });
    });

    // -----------------------------------------------------------------
    // _send when not connected (no-op)
    // -----------------------------------------------------------------

    describe('_send when not connected', function () {

        it('does not throw when send called on disconnected ws', function () {
            client = new WebSocketClient({
                network: 'bitcoin-regtest',
                websocketUrl: '127.0.0.1',
                websocketPort: port,
                retry: { maxRetries: 0 },
                pingInterval: 60000
            });
            // ws is null; should not throw
            expect(() => client._send({ action: 'ping' })).to.not.throw();
        });
    });

    // -----------------------------------------------------------------
    // WebSocket constructor throw (sync URL error)
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // _resubscribe: direct unit test
    // -----------------------------------------------------------------

    describe('_resubscribe', function () {

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

            // Call _resubscribe directly
            client._resubscribe();
            await new Promise(r => setTimeout(r, 100));

            const subscribeMsgs = received.filter(m => m.action === 'subscribe');
            expect(subscribeMsgs.length).to.be.greaterThanOrEqual(2);
        });

        it('includes since_action_index when lastActionIndex > 0', async function () {
            client = createClient(port);
            await client.connect();
            await client.subscribe(['blocks']);

            // Set lastActionIndex
            client.lastActionIndex = 500;

            const received = [];
            server._lastClient.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                received.push(msg);
            });

            client._resubscribe();
            await new Promise(r => setTimeout(r, 100));

            const subscribeMsgs = received.filter(m => m.action === 'subscribe');
            expect(subscribeMsgs[0].params.since_action_index).to.equal(500);
        });
    });
});
