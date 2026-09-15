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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onMarket', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onMarket', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onMarket', function () {
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
});
