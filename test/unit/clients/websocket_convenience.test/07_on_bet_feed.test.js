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
const { waitForCalls } = require('../../../helpers/wait.js');
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onBetFeed', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onBetFeed', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onBetFeed', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onBetFeed', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onBetFeed', function () {
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
});
