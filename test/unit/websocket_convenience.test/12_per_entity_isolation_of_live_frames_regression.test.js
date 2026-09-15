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
const sinon = require('sinon');
const { waitForCalls } = require('../../helpers/wait.js');
const { closeFixture, createFixture, passBarrier } = require('./support/setup.js');

let server, sdk;

function registerHooks() {
    beforeEach(async function () {
        ({ server, sdk } = await createFixture());
    });
    afterEach(function (done) {
        closeFixture(sdk, server, done);
    });
}

async function barrier() {
    await passBarrier(sdk, server);
}

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('per-entity isolation of live frames @regression', function () {
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
});
