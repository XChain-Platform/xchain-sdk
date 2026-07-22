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
const sinon       = require('sinon');
const WebSocket   = require('ws');
const { XChainSDK } = require('../../index.js');
const { SDKConfigError } = require('../../src/errors.js');

// ---------------------------------------------------------------------------
// Mock Server
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // Convenience methods
    // -----------------------------------------------------------------

    describe('onBlock', function () {

        it('subscribes to blocks and fires callback on NEW_BLOCK', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onBlock(spy);

            server._lastClient.send(JSON.stringify({
                type: 'NEW_BLOCK', data: { block_index: 101 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].data.block_index).to.equal(101);

            // Unsubscribe function works
            expect(typeof unsub).to.equal('function');
        });
    });

    describe('onAction', function () {

        it('subscribes to actions and fires callback', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAction(spy);

            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: 501, action: 'SEND' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });
    });

    describe('onAddress', function () {

        it('subscribes to address and fires on ADDRESS_UPDATE', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy);

            server._lastClient.send(JSON.stringify({
                type: 'ADDRESS_UPDATE', data: { address: '1abc', balances: [] }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on ORDER_MATCH events too', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy);

            server._lastClient.send(JSON.stringify({
                type: 'ORDER_MATCH', data: { action_index: 501 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the SNAPSHOT frame when opts.snapshot is requested', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy, { snapshot: true });

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'address', address: '1abc', balances: [] }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].type).to.equal('SNAPSHOT');
        });

        it('does not fire on a SNAPSHOT for a different address', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy, { snapshot: true });

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'address', address: '1other', balances: [] }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });

        it('removes the SNAPSHOT handler on unsubscribe', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onAddress('1abc', spy, { snapshot: true });
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'address', address: '1abc', balances: [] }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });
    });

    describe('onToken', function () {

        it('subscribes to token and fires on TOKEN_UPDATE', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onToken('PEPE', spy);

            server._lastClient.send(JSON.stringify({
                type: 'TOKEN_UPDATE', data: { tick: 'PEPE', supply: '100000' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the SNAPSHOT frame for the subscribed tick', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onToken('PEPE', spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'token', tick: 'PEPE', supply: '100000' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].type).to.equal('SNAPSHOT');
        });

        it('does not fire on a SNAPSHOT for a different tick', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onToken('PEPE', spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'token', tick: 'DOGE', supply: '1' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });

        it('removes the SNAPSHOT handler on unsubscribe', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onToken('PEPE', spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'token', tick: 'PEPE', supply: '100000' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });
    });

    describe('onMarket', function () {

        it('subscribes to market and fires on MARKET_UPDATE', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onMarket('PEPE', 'BTC', spy);

            server._lastClient.send(JSON.stringify({
                type: 'MARKET_UPDATE', data: { tick1: 'PEPE', tick2: 'BTC', last_price: '0.00000020' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the SNAPSHOT frame for the subscribed pair', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onMarket('PEPE', 'BTC', spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'market', tick1: 'PEPE', tick2: 'BTC', last_price: '0.00000020' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].type).to.equal('SNAPSHOT');
        });

        it('does not fire on a SNAPSHOT for a different pair', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onMarket('PEPE', 'BTC', spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'market', tick1: 'DOGE', tick2: 'BTC', last_price: '1' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });

        it('removes the SNAPSHOT handler on unsubscribe', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onMarket('PEPE', 'BTC', spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'market', tick1: 'PEPE', tick2: 'BTC', last_price: '1' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });
    });

    describe('onDispenser', function () {

        it('fires on DISPENSER_UPDATE and DISPENSE', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onDispenser(12345, spy);

            server._lastClient.send(JSON.stringify({
                type: 'DISPENSER_UPDATE', data: { action_index: 12345, give_remaining: '1000' }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'DISPENSE', data: { action_index: 501, dispenser_action_index: 12345 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.callCount).to.equal(2);
        });

        it('fires on the SNAPSHOT frame for the subscribed dispenser', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onDispenser(12345, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: 12345, give_remaining: '1000' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].type).to.equal('SNAPSHOT');
        });

        it('matches action_index across number/string wire representations', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onDispenser(12345, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: '12345', give_remaining: '1000' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });

        it('does not fire on a SNAPSHOT for a different dispenser', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onDispenser(12345, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: 999, give_remaining: '1' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });

        it('removes the SNAPSHOT handler on unsubscribe', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onDispenser(12345, spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: 12345, give_remaining: '1000' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.called).to.be.false;
        });
    });

    describe('onCoinpayRequired', function () {

        it('fires on COINPAY_REQUIRED', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onCoinpayRequired('1bot', spy);

            server._lastClient.send(JSON.stringify({
                type: 'COINPAY_REQUIRED',
                data: { payer_address: '1bot', payee_address: '1seller', coin_amount: '0.01', expiration: 9999 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].data.coin_amount).to.equal('0.01');
        });
    });

    describe('onOrderMatch', function () {

        it('fires on ORDER_MATCH', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onOrderMatch('1abc', spy);

            server._lastClient.send(JSON.stringify({
                type: 'ORDER_MATCH', data: { action_index: 501, settlement_type: 'coinpay' }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });
    });

    describe('onNetworkStats', function () {

        it('fires on NETWORK_STATS', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onNetworkStats(spy);

            server._lastClient.send(JSON.stringify({
                type: 'NETWORK_STATS', data: { block_height: 101 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Unsubscribe function
    // -----------------------------------------------------------------

    describe('unsubscribe return value', function () {

        it('onBlock returns function that removes handler', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onBlock(spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'NEW_BLOCK', data: { block_index: 101 }
            }));
            await new Promise(r => setTimeout(r, 50));

            expect(spy.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // : `statuses` must never be forwarded
    // -----------------------------------------------------------------

    describe('statuses filter is not advertised () @regression', function () {

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
            await new Promise((r) => setTimeout(r, 60));
            s.stop();
            await new Promise((r) => srv.wss.close(r));
            return srv.sent.map((m) => m.params || {});
        }

        it('onAction drops statuses but keeps the filters the server honors', async function () {
            const params = await paramsFor((s) => s.onAction(() => {}, {
                types: ['SEND'], statuses: ['pending_coinpay'], ticks: ['PEPE']
            }));
            expect(params.length).to.be.greaterThan(0);
            for (const p of params) expect(p).to.not.have.property('statuses');
            const merged = Object.assign({}, ...params);
            expect(merged.types).to.deep.equal(['SEND']);
            expect(merged.ticks).to.deep.equal(['PEPE']);
        });

        it('onAddress drops statuses but keeps types', async function () {
            const params = await paramsFor((s) => s.onAddress('1abc', () => {}, {
                types: ['ORDER_MATCH'], statuses: ['open']
            }));
            expect(params.length).to.be.greaterThan(0);
            for (const p of params) expect(p).to.not.have.property('statuses');
            const merged = Object.assign({}, ...params);
            expect(merged.types).to.deep.equal(['ORDER_MATCH']);
        });

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
