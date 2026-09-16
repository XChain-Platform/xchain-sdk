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

const { expect }  = require('chai');
const WebSocket   = require('ws');
const { XChainSDK } = require('../../../index.js');
const { SDKConfigError } = require('../../../src/utils/errors.js');

// Mock Server

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

// Tests

describe('XChainSDK – WebSocket convenience methods', function () {

    let server, port, sdk;

    beforeEach(async function () {
        const s = await createMockServer();
        server = s.wss;
        port   = s.port;

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

    // Initialization

    describe('initialization', function () {

        it('creates ws client when explorerUrl is configured', function () {
            const s = new XChainSDK({
                network: 'bitcoin-regtest',
                explorerUrl: 'localhost',
                explorerPort: 8080
            });
            expect(s.ws).to.not.be.null;
            expect(s.ws.coin).to.equal('RBTC');
        });

        it('ws is null when no URL configured', function () {
            const s = new XChainSDK({ network: 'bitcoin-regtest' });
            expect(s.ws).to.be.null;
        });

        it('_requireWs throws when ws is null', function () {
            const s = new XChainSDK({ network: 'bitcoin-regtest' });
            expect(() => s._requireWs()).to.throw(SDKConfigError);
        });

        it('stop() disconnects WebSocket', async function () {
            await sdk.connectWs();
            expect(sdk.ws.isConnected()).to.be.true;
            sdk.stop();
            expect(sdk.ws.isConnected()).to.be.false;
        });
    });
});
