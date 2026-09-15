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

const CALL_ID = 'a1b2c3d4'.repeat(8);

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onXcall', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onXcall', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onXcall', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onXcall', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onXcall', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onXcall', function () {
// Matched on the message body, not the method name, for the same reason
        // the onBetFeed case above is: a missing method throws too.
        it('rejects a call_id that is not 64 hex', async function () {
            await sdk.connectWs();
            expect(() => sdk.onXcall('abc', () => {})).to.throw(/must be a 64-character hex string/);
            expect(() => sdk.onXcall(null, () => {})).to.throw(/must be a 64-character hex string/);
            expect(() => sdk.onXcall('g'.repeat(64), () => {})).to.throw(/must be a 64-character hex string/);
        });
    });
});
