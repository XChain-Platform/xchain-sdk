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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
                // producer (protocol reference M5.4) and to go unregistered here.
                { type: 'XCALL_COMPLETED',      data: { action_index: 609, source: '1abc', call_id: 'a'.repeat(64), synthetic: true } },
                { type: 'XCALL_EXPIRED',        data: { action_index: 610, source: '1abc', call_id: 'b'.repeat(64), synthetic: false } },
                { type: 'ATTESTATION_REQUEST',  data: { action_index: 607, source: '1abc', version: 0 } },
                { type: 'ATTESTATION_RESPONSE', data: { action_index: 608, source: '1abc', version: 1 } }
            ];
            for (const f of frames) server._lastClient.send(JSON.stringify(f));
            await waitForCalls(spy, frames.length);

            expect(spy.getCalls().map(c => c.args[0].type)).to.deep.equal(frames.map(f => f.type));
        });
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
    });
});

describe('XChainSDK – WebSocket convenience methods', function () {
    registerHooks();
    describe('onAddress', function () {
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
});
