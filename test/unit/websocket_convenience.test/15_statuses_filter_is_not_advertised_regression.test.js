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

const { expect } = require('chai');
const WebSocket = require('ws');
const { XChainSDK } = require('../../../index.js');
const { waitFor } = require('../../helpers/wait.js');
const { closeFixture, createFixture } = require('./support/setup.js');

let server, sdk;

function registerHooks() {
    beforeEach(async function () {
        ({ server, sdk } = await createFixture());
    });
    afterEach(function (done) {
        closeFixture(sdk, server, done);
    });
}

// Records every SUBSCRIBE frame the SDK sends, so we assert on the
// wire params rather than on internals.
function recordingServer() {
    return new Promise((resolve) => {
        const sent = [];
        const wss = new WebSocket.Server({ port: 0 }, () => {
            wss.on('connection', (ws) => {
                ws.send(JSON.stringify({
                    type: 'WELCOME', chain: 'BTC', network: 'regtest',
                    timestamp: Date.now(),
                    data: { version: '1.0.0', server_time: Date.now(),
                            latest_block_index: 100, channels: [], types: [], features: [] }
                }));
                ws.on('message', (data) => {
                    const msg = JSON.parse(data.toString());
                    if (msg.action === 'subscribe') {
                        sent.push(msg);
                        ws.send(JSON.stringify({
                            type: 'SUBSCRIBED', id: msg.id, timestamp: Date.now(),
                            data: { channel: msg.channels[0], active_filters: {} }
                        }));
                    }
                });
            });
            resolve({ wss, port: wss.address().port, sent });
        });
    });
}

async function paramsFor(fn) {
    const srv = await recordingServer();
    const s = new XChainSDK({
        network: 'bitcoin-regtest', explorerUrl: 'localhost', explorerPort: srv.port
    });
    await s.connectWs();
    fn(s);
    // Wait for the subscribe frame to REACH the recording server, rather
    // than for a duration that is only usually long enough.
    await waitFor(() => srv.sent.length > 0, { message: 'no subscribe frame reached the server' });
    s.stop();
    await new Promise((r) => srv.wss.close(r));
    return srv.sent.map((m) => m.params || {});
}

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    // `statuses` must never be forwarded

    describe('statuses filter is not advertised @regression', function () {
it('onAction drops statuses and ticks but keeps the filters the server honors', async function () {
            const params = await paramsFor((s) => s.onAction(() => {}, {
                types: ['SEND'], statuses: ['pending_coinpay'], ticks: ['PEPE']
            }));
            expect(params.length).to.be.greaterThan(0);
            for (const p of params) {
                expect(p).to.not.have.property('statuses');
                // #3860: no action frame carries a tick, so a forwarded ticks filter
                // would promise a stream that never narrows.
                expect(p).to.not.have.property('ticks');
            }
            const merged = Object.assign({}, ...params);
            expect(merged.types).to.deep.equal(['SEND']);
        });
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('statuses filter is not advertised @regression', function () {
it('onAddress drops statuses but keeps types', async function () {
            const params = await paramsFor((s) => s.onAddress('1abc', () => {}, {
                types: ['ORDER_MATCH'], statuses: ['open']
            }));
            expect(params.length).to.be.greaterThan(0);
            for (const p of params) expect(p).to.not.have.property('statuses');
            const merged = Object.assign({}, ...params);
            expect(merged.types).to.deep.equal(['ORDER_MATCH']);
        });
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('statuses filter is not advertised @regression', function () {
it('onOrderMatch drops statuses and still pins types to ORDER_MATCH', async function () {
            const params = await paramsFor((s) => s.onOrderMatch('1abc', () => {}, {
                statuses: ['filled']
            }));
            expect(params.length).to.be.greaterThan(0);
            for (const p of params) expect(p).to.not.have.property('statuses');
            const merged = Object.assign({}, ...params);
            expect(merged.types).to.deep.equal(['ORDER_MATCH']);
        });
    });
});
