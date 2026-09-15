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
const WebSocketClient = require('../../src/clients/websocket.js');
const { SDKExplorerError } = require('../../src/utils/errors.js');
const { waitFor, waitForCalls } = require('../helpers/wait.js');

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

// Schema version surface
describe('WebSocketClient', function () {
    registerHooks();
    describe('WS_SCHEMA_VERSION', function () {

        it('is exposed as a static on the client class', function () {
            const WebSocketClient = require('../../src/clients/websocket.js');
            expect(WebSocketClient.WS_SCHEMA_VERSION).to.be.a('number');
            expect(WebSocketClient.WS_SCHEMA_VERSION).to.equal(2);
        });

        it('matches the explorer sibling schema version when checked out (cross-repo drift guard)', function () {
            const path = require('path');
            const fs = require('fs');
            const explorerDir = path.join(__dirname, '..', '..', '..', 'xchain-explorer');
            const explorerSchema = path.join(explorerDir, 'src', 'ws', 'schema_version.js');
            // Skip only for a standalone clone with no explorer beside it. With
            // the checkout present, a missing file means the constant moved and
            // this guard must follow it, never go quietly pending.
            if (!fs.existsSync(path.join(explorerDir, 'package.json'))) return this.skip();
            expect(fs.existsSync(explorerSchema),
                path.relative(explorerDir, explorerSchema) + ' is gone from xchain-explorer; repoint this drift guard').to.be.true;
            const WebSocketClient = require('../../src/clients/websocket.js');
            expect(require(explorerSchema).WS_SCHEMA_VERSION).to.equal(WebSocketClient.WS_SCHEMA_VERSION);
        });
    });
});
// Connection
describe('WebSocketClient', function () {
    registerHooks();
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

        it('seeds lastActionIndex from WELCOME as an exact decimal string', async function () {
            client = createClient(port);
            await client.connect();
            expect(client.lastActionIndex).to.equal('500');
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
});

// Coin prefix
describe('WebSocketClient', function () {
    registerHooks();
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
});

// Subscribe
describe('WebSocketClient', function () {
    registerHooks();
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
});

// Unsubscribe
describe('WebSocketClient', function () {
    registerHooks();
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
});

// List subscriptions
describe('WebSocketClient', function () {
    registerHooks();
    describe('listSubscriptions', function () {

        it('returns SUBSCRIPTION_LIST', async function () {
            client = createClient(port);
            await client.connect();
            const result = await client.listSubscriptions();
            expect(result.type).to.equal('SUBSCRIPTION_LIST');
            expect(result.data.count).to.equal(0);
        });
    });
});
