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
 * Unit tests for XChainSDK WebSocket convenience methods
 *
 * Tests onBlock, onAddress, onCoinpayRequired, onOrderMatch, etc.
 */

'use strict';

const sinon = require('sinon');
const WebSocket = require('ws');
const { XChainSDK } = require('../../../../../index.js');
const { waitForCalls } = require('../../../../helpers/wait.js');

function createMockServer() {
    return new Promise((resolve) => {
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
                        channels: ['blocks', 'actions', 'address', 'token', 'market', 'dispenser', 'network'],
                        types: [],
                        features: []
                    }
                }));

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
                });

                wss._lastClient = ws;
            });

            resolve({ wss, port });
        });
    });
}

async function createFixture() {
    const { wss: server, port } = await createMockServer();
    const sdk = new XChainSDK({
        network: 'bitcoin-regtest',
        websocketUrl: '127.0.0.1',
        websocketPort: port
    });
    return { server, port, sdk };
}

function closeFixture(sdk, server, done) {
    if (sdk) sdk.stop();
    server.close(done);
}

// Deterministic barrier for a NEGATIVE assertion (this callback must NOT
// fire). There is no condition to poll for something that never happens, so
// send a frame that IS observably handled and wait for THAT: one socket
// delivers in order, so once the barrier lands the frame under test has
// already been dispatched (or correctly ignored). A fixed sleep only made
// the race less likely; this removes it.
async function passBarrier(sdk, server) {
    const mark = sinon.spy();
    const unsub = sdk.onBlock(mark);
    server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 0 } }));
    await waitForCalls(mark, 1, { message: 'barrier NEW_BLOCK never arrived' });
    unsub();
}

module.exports = { closeFixture, createFixture, passBarrier };
