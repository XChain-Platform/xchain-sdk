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
const { waitFor, waitForCalls } = require('../helpers/wait.js');

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

    // Deterministic barrier for a NEGATIVE assertion (this callback must NOT
    // fire). There is no condition to poll for something that never happens, so
    // send a frame that IS observably handled and wait for THAT: one socket
    // delivers in order, so once the barrier lands the frame under test has
    // already been dispatched (or correctly ignored). A fixed sleep only made
    // the race less likely; this removes it.
    async function barrier() {
        const mark = sinon.spy();
        const unsub = sdk.onBlock(mark);
        server._lastClient.send(JSON.stringify({ type: 'NEW_BLOCK', data: { block_index: 0 } }));
        await waitForCalls(mark, 1, { message: 'barrier NEW_BLOCK never arrived' });
        unsub();
    }

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

    // Convenience methods

    describe('onBlock', function () {

        it('subscribes to blocks and fires callback on NEW_BLOCK', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onBlock(spy);

            server._lastClient.send(JSON.stringify({
                type: 'NEW_BLOCK', data: { block_index: 101 }
            }));
            await waitForCalls(spy);

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
            await waitForCalls(spy);

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
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on ORDER_MATCH events too', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy);

            server._lastClient.send(JSON.stringify({
                type: 'ORDER_MATCH', data: { action_index: 501 }
            }));
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the SNAPSHOT frame when opts.snapshot is requested', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy, { snapshot: true });

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'address', address: '1abc', balances: [] }
            }));
            await waitForCalls(spy);

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
            await barrier();

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
            await barrier();

            expect(spy.called).to.be.false;
        });

        // The explorer's Broadcaster._onLifecycleEvent routes EVERY lifecycle event
        // to the address channel of each address its `data` names, independently of
        // the event's own entity channel. A type absent from the registration list
        // is therefore a frame the server sends and this client silently drops.
        // These are the nine names that were absent, plus the two XCALL phases
        // that later shipped on the producer and were dropped the same way.
        it('fires on the later lifecycle types the explorer routes to an address @regression', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy);

            const frames = [
                { type: 'ORDER_EXPIRED',        data: { action_index: 601, source: '1abc' } },
                { type: 'SWAP_EXPIRED',         data: { action_index: 602, source: '1abc' } },
                { type: 'DISPENSER_CLOSED',     data: { action_index: 603, source: '1abc', dispenser_action_index: 9 } },
                { type: 'DISPENSER_EXPIRED',    data: { action_index: 604, source: '1abc', dispenser_action_index: 9 } },
                { type: 'BET',                  data: { action_index: 605, source: '1abc', feed_action_index: 7, action_format: 2 } },
                { type: 'BET_EXPIRED',          data: { action_index: 606, source: '1abc', feed_action_index: 7 } },
                { type: 'BET_CLOSED',           data: { action_index: 7,   source: '1abc', feed_action_index: 7, synthetic: true } },
                // The two XCALL terminal phases were the next pair to ship on the
                // producer (spec M5.4) and to go unregistered here.
                { type: 'XCALL_COMPLETED',      data: { action_index: 609, source: '1abc', call_id: 'a'.repeat(64), synthetic: true } },
                { type: 'XCALL_EXPIRED',        data: { action_index: 610, source: '1abc', call_id: 'b'.repeat(64), synthetic: false } },
                { type: 'ATTESTATION_REQUEST',  data: { action_index: 607, source: '1abc', version: 0 } },
                { type: 'ATTESTATION_RESPONSE', data: { action_index: 608, source: '1abc', version: 1 } }
            ];
            for (const f of frames) server._lastClient.send(JSON.stringify(f));
            await waitForCalls(spy, frames.length);

            expect(spy.getCalls().map(c => c.args[0].type)).to.deep.equal(frames.map(f => f.type));
        });

        it('still scopes those later lifecycle types to the subscribed address', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAddress('1abc', spy);

            server._lastClient.send(JSON.stringify({
                type: 'DISPENSER_CLOSED', data: { action_index: 701, source: '1other' }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_RESPONSE', data: { action_index: 702, source: '1other' }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        it('unsubscribe detaches the later lifecycle handlers too', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onAddress('1abc', spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'BET_CLOSED', data: { action_index: 7, source: '1abc', feed_action_index: 7 }
            }));
            await barrier();

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
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the SNAPSHOT frame for the subscribed tick', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onToken('PEPE', spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'token', tick: 'PEPE', supply: '100000' }
            }));
            await waitForCalls(spy);

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
            await barrier();

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
            await barrier();

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
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the SNAPSHOT frame for the subscribed pair', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onMarket('PEPE', 'BTC', spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'market', tick1: 'PEPE', tick2: 'BTC', last_price: '0.00000020' }
            }));
            await waitForCalls(spy);

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
            await barrier();

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
            await barrier();

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
            await waitForCalls(spy);

            expect(spy.callCount).to.equal(2);
        });

        it('fires on the SNAPSHOT frame for the subscribed dispenser', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onDispenser(12345, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: 12345, give_remaining: '1000' }
            }));
            await waitForCalls(spy);

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
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('does not fire on a SNAPSHOT for a different dispenser', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onDispenser(12345, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: 999, give_remaining: '1' }
            }));
            await barrier();

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
            await barrier();

            expect(spy.called).to.be.false;
        });
    });

    describe('onBetFeed', function () {

        it('fires on BET, BET_EXPIRED and BET_CLOSED for the subscribed feed', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onBetFeed(7, spy);

            server._lastClient.send(JSON.stringify({
                type: 'BET', data: { action_index: 801, feed_action_index: 7, action_format: 2 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'BET_EXPIRED', data: { action_index: 802, feed_action_index: 7 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'BET_CLOSED', data: { action_index: 7, feed_action_index: 7, synthetic: true }
            }));
            await waitForCalls(spy, 3);

            expect(spy.getCalls().map(c => c.args[0].type))
                .to.deep.equal(['BET', 'BET_EXPIRED', 'BET_CLOSED']);
        });

        // The guard is on feed_action_index, not action_index: a BET frame's own
        // action_index is the individual bet, and 801 is a different feed's bet.
        it('does not fire on a bet placed on a different feed', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onBetFeed(7, spy);

            server._lastClient.send(JSON.stringify({
                type: 'BET', data: { action_index: 801, feed_action_index: 8, action_format: 2 }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        it('fires on the bet_feed SNAPSHOT frame, matching number/string wire forms', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onBetFeed(7, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'bet_feed', action_index: '7', feed_status: 'open' }
            }));
            await waitForCalls(spy);

            expect(spy.firstCall.args[0].type).to.equal('SNAPSHOT');
        });

        it('does not fire on a SNAPSHOT for a different feed or another channel', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onBetFeed(7, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'bet_feed', action_index: 8 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'dispenser', action_index: 7 }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        it('unsubscribe removes every handler it registered, SNAPSHOT included', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onBetFeed(7, spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'BET', data: { action_index: 801, feed_action_index: 7 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'bet_feed', action_index: 7 }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        // Matched on the message body, not the method name: a missing method
        // throws "sdk.onBetFeed is not a function", which a /onBetFeed/ pattern
        // would accept as a pass on a build that never implemented it.
        it('rejects a non-canonical feed action index', async function () {
            await sdk.connectWs();
            expect(() => sdk.onBetFeed('abc', () => {})).to.throw(/must be a numeric ACTION_INDEX/);
            expect(() => sdk.onBetFeed(null, () => {})).to.throw(/must be a numeric ACTION_INDEX/);
            expect(() => sdk.onBetFeed('-1', () => {})).to.throw(/must be a numeric ACTION_INDEX/);
        });
    });

    describe('onXcall', function () {

        const CALL_ID = 'a1b2c3d4'.repeat(8);

        it('fires on both terminal phases for the subscribed call', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onXcall(CALL_ID, spy);

            server._lastClient.send(JSON.stringify({
                type: 'XCALL_COMPLETED',
                data: { call_id: CALL_ID, action_index: 901, request_status: 'completed', synthetic: true }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'XCALL_EXPIRED',
                data: { call_id: CALL_ID, action_index: 902, request_status: 'expired', result_status: null }
            }));
            await waitForCalls(spy, 2);

            expect(spy.getCalls().map(c => c.args[0].type))
                .to.deep.equal(['XCALL_COMPLETED', 'XCALL_EXPIRED']);
        });

        it('does not fire on another call\'s terminal phase', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onXcall(CALL_ID, spy);

            server._lastClient.send(JSON.stringify({
                type: 'XCALL_COMPLETED', data: { call_id: 'f'.repeat(64), action_index: 903 }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        // Only the Broadcaster's ROUTING key is lower-cased, so an id that comes
        // back upper-cased inside `data` is the same call and must still deliver.
        it('matches the frame call_id case-insensitively', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onXcall(CALL_ID, spy);

            server._lastClient.send(JSON.stringify({
                type: 'XCALL_COMPLETED', data: { call_id: CALL_ID.toUpperCase(), action_index: 904 }
            }));
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('fires on the xcall SNAPSHOT frame and not another channel\'s', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onXcall(CALL_ID, spy);

            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'bet_feed', action_index: 7, call_id: CALL_ID }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'xcall', call_id: CALL_ID, request_status: 'pending' }
            }));
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
            expect(spy.firstCall.args[0].data.channel).to.equal('xcall');
        });

        it('unsubscribe removes every handler it registered, SNAPSHOT included', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onXcall(CALL_ID, spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'XCALL_EXPIRED', data: { call_id: CALL_ID, action_index: 905 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'SNAPSHOT', data: { channel: 'xcall', call_id: CALL_ID }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        // Matched on the message body, not the method name, for the same reason
        // the onBetFeed case above is: a missing method throws too.
        it('rejects a call_id that is not 64 hex', async function () {
            await sdk.connectWs();
            expect(() => sdk.onXcall('abc', () => {})).to.throw(/must be a 64-character hex string/);
            expect(() => sdk.onXcall(null, () => {})).to.throw(/must be a 64-character hex string/);
            expect(() => sdk.onXcall('g'.repeat(64), () => {})).to.throw(/must be a 64-character hex string/);
        });
    });

    describe('onAttestation', function () {

        it('fires on both attestation phases', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onAttestation(spy);

            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_REQUEST', data: { action_index: 901, version: 0, request_id: 'r1' }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_RESPONSE', data: { action_index: 902, version: 1, request_id: 'r1' }
            }));
            await waitForCalls(spy, 2);

            expect(spy.getCalls().map(c => c.args[0].type))
                .to.deep.equal(['ATTESTATION_REQUEST', 'ATTESTATION_RESPONSE']);
        });

        it('unsubscribe removes both handlers', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onAttestation(spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_REQUEST', data: { action_index: 901, version: 0 }
            }));
            server._lastClient.send(JSON.stringify({
                type: 'ATTESTATION_RESPONSE', data: { action_index: 902, version: 1 }
            }));
            await barrier();

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
            await waitForCalls(spy);

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
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });
    });

    // Entity isolation across CONCURRENT same-type subscriptions
    //
    // One socket carries every entity subscription for a coin and WebSocketClient
    // dispatches on msg.type alone, so before the per-entity guards a second
    // subscription of the same type received the FIRST one's live frames (and vice
    // versa) with no error: each callback silently read the wrong entity's data.
    // The counterpart assertion is that a frame carrying no discriminator at all is
    // still delivered - the lifecycle frames name their party in whichever field
    // the event has, and some name none, so a strict guard would drop them.

    describe('per-entity isolation of live frames @regression', function () {

        it('onToken delivers a TOKEN_UPDATE only to the subscribed tick', async function () {
            await sdk.connectWs();
            const pepe = sinon.spy(), doge = sinon.spy();
            sdk.onToken('PEPE', pepe);
            sdk.onToken('DOGE', doge);

            server._lastClient.send(JSON.stringify({
                type: 'TOKEN_UPDATE', data: { channel: 'token', tick: 'PEPE', supply: '100000' }
            }));
            await waitForCalls(pepe);

            expect(pepe.calledOnce).to.be.true;
            expect(doge.called).to.be.false;
        });

        it('onMarket delivers a MARKET_UPDATE only to the subscribed pair', async function () {
            await sdk.connectWs();
            const pepeBtc = sinon.spy(), dogeBtc = sinon.spy();
            sdk.onMarket('PEPE', 'BTC', pepeBtc);
            sdk.onMarket('DOGE', 'BTC', dogeBtc);

            server._lastClient.send(JSON.stringify({
                type: 'MARKET_UPDATE', data: { channel: 'market', tick1: 'PEPE', tick2: 'BTC', last_price: '1' }
            }));
            await waitForCalls(pepeBtc);

            expect(pepeBtc.calledOnce).to.be.true;
            expect(dogeBtc.called).to.be.false;
        });

        it('onDispenser separates both the entity frame and the lifecycle frame', async function () {
            await sdk.connectWs();
            const mine = sinon.spy(), other = sinon.spy();
            sdk.onDispenser(12345, mine);
            sdk.onDispenser(999, other);

            // Entity frame: keyed on the dispenser's own action_index.
            server._lastClient.send(JSON.stringify({
                type: 'DISPENSER_UPDATE', data: { channel: 'dispenser', action_index: 12345, give_remaining: '1000' }
            }));
            // Lifecycle frame: action_index is the DISPENSE's own, the parent is
            // named in dispenser_action_index.
            server._lastClient.send(JSON.stringify({
                type: 'DISPENSE', data: { action_index: 501, dispenser_action_index: 12345 }
            }));
            await waitForCalls(mine, 2);

            expect(mine.callCount).to.equal(2);
            expect(other.called).to.be.false;
        });

        it('onAddress delivers an ADDRESS_UPDATE only to the subscribed address', async function () {
            await sdk.connectWs();
            const a = sinon.spy(), b = sinon.spy();
            sdk.onAddress('1abc', a);
            sdk.onAddress('1other', b);

            server._lastClient.send(JSON.stringify({
                type: 'ADDRESS_UPDATE', data: { channel: 'address', address: '1abc', balances: [] }
            }));
            await waitForCalls(a);

            expect(a.calledOnce).to.be.true;
            expect(b.called).to.be.false;
        });

        it('onAddress reads the party out of whichever field the lifecycle frame names', async function () {
            await sdk.connectWs();
            const payer = sinon.spy(), stranger = sinon.spy();
            sdk.onAddress('1bot', payer);
            sdk.onAddress('1nobody', stranger);

            // COINPAY_REQUIRED carries no `address`: the server routes it on
            // payer_address / payee_address (Broadcaster._extractAddresses).
            server._lastClient.send(JSON.stringify({
                type: 'COINPAY_REQUIRED',
                data: { payer_address: '1bot', payee_address: '1seller', coin_amount: '0.01' }
            }));
            // NEW_ACTION names its party in `source`.
            server._lastClient.send(JSON.stringify({
                type: 'NEW_ACTION', data: { action_index: 502, action: 'SEND', source: '1bot' }
            }));
            await waitForCalls(payer, 2);

            expect(payer.callCount).to.equal(2);
            expect(stranger.called).to.be.false;
        });

        it('still delivers a frame that names no party at all (no silent drop)', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onOrderMatch('1abc', spy);

            // An ORDER_MATCH with no address-bearing field reaches this socket only
            // because the server routed it here, so dropping it would lose the event.
            server._lastClient.send(JSON.stringify({
                type: 'ORDER_MATCH', data: { action_index: 501, settlement_type: 'coinpay' }
            }));
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });

        it('onCoinpayRequired ignores another address\'s obligation', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            sdk.onCoinpayRequired('1bot', spy);

            server._lastClient.send(JSON.stringify({
                type: 'COINPAY_REQUIRED',
                data: { payer_address: '1someoneelse', payee_address: '1seller', coin_amount: '0.01' }
            }));
            await barrier();

            expect(spy.called).to.be.false;
        });

        it('unsubscribe detaches the guarded handler, not just the raw callback', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onToken('PEPE', spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'TOKEN_UPDATE', data: { channel: 'token', tick: 'PEPE', supply: '1' }
            }));
            await barrier();

            expect(spy.called).to.be.false;
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
            await waitForCalls(spy);

            expect(spy.calledOnce).to.be.true;
        });
    });

    // Unsubscribe function

    describe('unsubscribe return value', function () {

        it('onBlock returns function that removes handler', async function () {
            await sdk.connectWs();
            const spy = sinon.spy();
            const unsub = sdk.onBlock(spy);
            unsub();

            server._lastClient.send(JSON.stringify({
                type: 'NEW_BLOCK', data: { block_index: 101 }
            }));
            await barrier();

            expect(spy.callCount).to.equal(0);
        });
    });

    // `statuses` must never be forwarded

    describe('statuses filter is not advertised @regression', function () {

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
