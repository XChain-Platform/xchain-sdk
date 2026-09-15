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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onDispenser', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onDispenser', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onDispenser', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onDispenser', function () {
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
});
