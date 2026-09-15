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
const WebSocketClient = require('../../../src/clients/websocket.js');
const { SDKExplorerError } = require('../../../src/utils/errors.js');
const { waitFor, waitForCalls } = require('../../helpers/wait.js');

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

// Deterministic barrier for a NEGATIVE assertion (this handler must NOT
// fire). Nothing can be polled for an event that never happens, so send a
// frame that IS observably handled and wait for that: one socket delivers in
// order, so once the barrier lands the frame under test has already been
// dispatched or correctly dropped. A fixed sleep only made the race rarer.
async function barrier() {
    const mark = sinon.spy();
    client.on('BARRIER', mark);
    server._lastClient.send(JSON.stringify({ type: 'BARRIER', data: {} }));
    await waitForCalls(mark, 1, { message: 'barrier frame never arrived' });
    client.off('BARRIER', mark);
}

// Event handlers
describe('WebSocketClient', function () {
    registerHooks();
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

            await waitForCalls(spy);

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

            await barrier();

            expect(spy.callCount).to.equal(0);
        });
    });
});
describe('WebSocketClient', function () {
    registerHooks();
    describe('event handlers', function () {
        it('once() fires handler only once then removes', async function () {
            client = createClient(port);
            await client.connect();

            const spy = sinon.spy();
            client.once('NEW_BLOCK', spy);

            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 101 } }));
            await waitForCalls(spy);
            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 102 } }));
            await barrier();                       // the second frame must NOT reach spy

            expect(spy.calledOnce).to.be.true;
        });

        it('wildcard handler receives all events', async function () {
            client = createClient(port);
            await client.connect();

            const spy = sinon.spy();
            client.on('*', spy);

            server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: {} }));
            server._lastClient.send(JSON.stringify({ type: 'NEW_ACTION', data: {} }));
            await waitForCalls(spy, 2);

            expect(spy.callCount).to.equal(2);
        });
    });
});

describe('WebSocketClient', function () {
    registerHooks();
    describe('event handlers', function () {
        it('tracks lastActionIndex from events', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.lastActionIndex).to.equal('500'); // from WELCOME

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: 505 }
            }));
            await waitFor(() => client.lastActionIndex === '505',
                { message: 'lastActionIndex stayed at ' + client.lastActionIndex });

            expect(client.lastActionIndex).to.equal('505');
        });

        // #4154: the wire carries action indexes as exact decimal strings precisely
        // because they can exceed 2^53. Number("9007199254740995") is 9007199254740996,
        // so the old cursor replayed from AFTER an action it had never been handed.
        it('keeps an above-2^53 action_index exact instead of rounding it', async function () {
            client = createClient(port);
            await client.connect();

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: '9007199254740995' }
            }));
            await waitFor(() => client.lastActionIndex === '9007199254740995',
                { message: 'lastActionIndex stayed at ' + client.lastActionIndex });

            expect(client.lastActionIndex).to.equal('9007199254740995');
            // Names the rounding the string cursor exists to avoid: the old Number()
            // path stored this index one higher than the server ever emitted.
            expect(String(Number(client.lastActionIndex))).to.equal('9007199254740996');
        });
    });
});

describe('WebSocketClient', function () {
    registerHooks();
    describe('event handlers', function () {
        it('does not move the cursor backwards for a lower index', async function () {
            client = createClient(port);
            await client.connect();

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: '505' }
            }));
            await waitFor(() => client.lastActionIndex === '505',
                { message: 'lastActionIndex stayed at ' + client.lastActionIndex });

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: '499' }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: '506' }
            }));
            await waitFor(() => client.lastActionIndex === '506',
                { message: 'lastActionIndex stayed at ' + client.lastActionIndex });

            expect(client.lastActionIndex).to.equal('506');
        });
    });
});

// Lifecycle hooks
describe('WebSocketClient', function () {
    registerHooks();
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
});

// Catch-up tracking
describe('WebSocketClient', function () {
    registerHooks();
    describe('catch-up', function () {

        it('tracks catching up state from catch_up flag', async function () {
            client = createClient(port);
            await client.connect();

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', catch_up: true, data: { action_index: 501 }
            }));
            await waitFor(() => client.catchingUp === true, { message: 'catchingUp never set' });
            expect(client.catchingUp).to.be.true;

            server._lastClient.send(JSON.stringify({
                type: 'CATCH_UP_COMPLETE', data: { events_replayed: 1, latest_action_index: 501 }
            }));
            await waitFor(() => client.catchingUp === false, { message: 'catchingUp never cleared' });
            expect(client.catchingUp).to.be.false;
        });
    });
});

// connect() when already connected (short-circuit)
describe('WebSocketClient', function () {
    registerHooks();
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
});

// readyHook
describe('WebSocketClient', function () {
    registerHooks();
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
});
