// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const sinon   = require('sinon');
const XChainSDK = require('../../../../src/XChainSDK.js');

// Helpers

// Env vars the SDK reads: clear them so tests are deterministic
const ENV_KEYS = ['NETWORK', 'EXPLORER_URL', 'EXPLORER_PORT', 'ENCODER_URL',
    'ENCODER_PORT', 'HUB_API_HOST', 'HUB_PORT', 'WEBSOCKET_URL', 'WEBSOCKET_PORT'];

// Build a minimal SDK pointed at a local regtest stack so no public
// defaults + no auto-hub are injected
function makeSDK(extra = {}) {
    return new XChainSDK(Object.assign({
        network:     'bitcoin-regtest',
        explorerUrl: 'http://localhost:8080',
        encoderUrl:  'http://localhost:3000',
        retry: false
    }, extra));
}

function registerEnvHooks() {
    let saved;
    beforeEach(function () {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });
}


    let sdk;

    function makeSDKWithWs() {
        const s = makeSDK();
        s.ws = {
            connect:      sinon.stub().resolves({}),
            disconnect:   sinon.stub(),
            on:           sinon.stub(),
            off:          sinon.stub(),
            subscribe:    sinon.stub().resolves({ type: 'SUBSCRIBED', data: { channel: 'blocks' } }),
            unsubscribe:  sinon.stub()
        };
        return s;
    }

describe('XChainSDK', function () {
    registerEnvHooks();

    // WebSocket convenience methods

    describe('WebSocket methods', function () {

        it('connectWs delegates to ws.connect', async function () {
            sdk = makeSDKWithWs();
            await sdk.connectWs();
            expect(sdk.ws.connect.calledOnce).to.be.true;
        });

        it('disconnectWs delegates to ws.disconnect', function () {
            sdk = makeSDKWithWs();
            sdk.disconnectWs();
            expect(sdk.ws.disconnect.calledOnce).to.be.true;
        });

        it('disconnectWs is a no-op when ws is null', function () {
            sdk = makeSDK();
            sdk.ws = null;
            expect(() => sdk.disconnectWs()).to.not.throw();
        });

        it('onBlock registers handler and subscribes to blocks channel', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onBlock(cb);
            expect(sdk.ws.on.calledWith('NEW_BLOCK', cb)).to.be.true;
            expect(sdk.ws.subscribe.called).to.be.true;
            expect(typeof unsub).to.equal('function');
            unsub();
            expect(sdk.ws.off.calledWith('NEW_BLOCK', cb)).to.be.true;
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        // The `statuses` key in this assertion pinned the BUG. The SDK
        // forwarded a filter no explorer channel honors (getActionsSince selects
        // `NULL as status`), so a caller believed it had a filtered stream and did
        // not. The supported filters are asserted here; the dropped one below.
        it('onAction registers handler and subscribes with params when given', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { types: ['SEND'], ticks: ['TOKEN'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ types: ['SEND'] });
            unsub();
        });

        it('onAction does not forward the unsupported statuses or ticks filters', function () {
            // The ticks filter joins statuses as a filter no action frame can honor -
            // getActionsSince selects no tick column, so it never narrows anything.
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { types: ['SEND'], statuses: ['valid'], ticks: ['TOKEN'] });
            const params = sdk.ws.subscribe.firstCall.args[1];
            expect(params).to.not.have.property('statuses');
            expect(params).to.not.have.property('ticks');
            expect(params).to.deep.equal({ types: ['SEND'] });
            unsub();
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        it('#3860: onAction with only a ticks filter subscribes with no params at all', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAction(cb, { ticks: ['TOKEN'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.equal(undefined);
            unsub();
        });

        it('onAction subscribes without params when opts empty', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            sdk.onAction(cb);
            // params should be undefined (empty object has no keys)
            expect(sdk.ws.subscribe.firstCall.args[1]).to.equal(undefined);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        it('onAddress registers multiple handlers and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onAddress('addr1', cb, { snapshot: true });
            expect(sdk.ws.subscribe.firstCall.args[0]).to.deep.equal(['address']);
            expect(sdk.ws.subscribe.firstCall.args[1].address).to.equal('addr1');
            expect(sdk.ws.subscribe.firstCall.args[1].snapshot).to.be.true;
            unsub();
        });

        it('onToken registers handler and subscribes with tick+snapshot', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onToken('TOKEN', cb);
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ tick: 'TOKEN', snapshot: true });
            unsub();
        });

        it('onMarket registers handler and subscribes with tick1/tick2', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onMarket('A', 'B', cb);
            expect(sdk.ws.subscribe.firstCall.args[1]).to.deep.equal({ tick1: 'A', tick2: 'B', snapshot: true });
            unsub();
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        it('onDispenser registers multiple handlers and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onDispenser(42, cb);
            expect(sdk.ws.subscribe.firstCall.args[1].action_index).to.equal(42);
            unsub();
        });

        it('onCoinpayRequired registers handler and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onCoinpayRequired('addr1', cb);
            expect(sdk.ws.subscribe.firstCall.args[1].address).to.equal('addr1');
            unsub();
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        it('onOrderMatch registers handler and subscribes', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onOrderMatch('addr1', cb);
            const params = sdk.ws.subscribe.firstCall.args[1];
            expect(params.address).to.equal('addr1');
            expect(params.types).to.deep.equal(['ORDER_MATCH']);
            unsub();
        });

        // A caller-supplied `statuses` filter has no matching explorer channel:
        // getActionsSince selects `NULL as status`, so the filter cannot reject
        // anything. The SDK and server omit it from subscriptions, WELCOME features
        // and SUBSCRIBED active_filters.
        it('onOrderMatch does not forward the unsupported statuses filter', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onOrderMatch('addr1', cb, { statuses: ['pending'] });
            expect(sdk.ws.subscribe.firstCall.args[1]).to.not.have.property('statuses');
            unsub();
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        it('onNetworkStats registers handler and subscribes to network', function () {
            sdk = makeSDKWithWs();
            const cb = sinon.spy();
            const unsub = sdk.onNetworkStats(cb);
            expect(sdk.ws.subscribe.firstCall.args[0]).to.deep.equal(['network']);
            unsub();
        });

        it('waitForAction creates ActionWaiter and calls waitForTxid', async function () {
            sdk = makeSDK();
            const ActionWaiter = require('../../../../src/utils/action_waiter.js');
            sinon.stub(ActionWaiter.prototype, 'waitForTxid').resolves({ action_index: 42 });
            const result = await sdk.waitForAction('txid1', { timeout: 5000 });
            expect(result.action_index).to.equal(42);
        });

        it('waitForActionIndex creates ActionWaiter and calls waitForActionIndex', async function () {
            sdk = makeSDK();
            const ActionWaiter = require('../../../../src/utils/action_waiter.js');
            sinon.stub(ActionWaiter.prototype, 'waitForActionIndex').resolves({ action_index: 99 });
            const result = await sdk.waitForActionIndex(99, {});
            expect(result.action_index).to.equal(99);
        });
    });
});

describe('XChainSDK', function () {
    registerEnvHooks();

    describe('WebSocket methods', function () {

        it('waitForContractState creates ActionWaiter and gates on contract state', async function () {
            sdk = makeSDK();
            const ActionWaiter = require('../../../../src/utils/action_waiter.js');
            const stub = sinon.stub(ActionWaiter.prototype, 'waitForContractState').resolves({ value: 'FUNDED' });
            const result = await sdk.waitForContractState(73, { key: 'status', equals: 'FUNDED' });
            expect(result.value).to.equal('FUNDED');
            expect(stub.firstCall.args[0]).to.equal(73);
        });

        it('waitForContractBalance creates ActionWaiter and gates on the contract balance', async function () {
            sdk = makeSDK();
            const ActionWaiter = require('../../../../src/utils/action_waiter.js');
            const stub = sinon.stub(ActionWaiter.prototype, 'waitForContractBalance').resolves({ quantity: '1000' });
            const result = await sdk.waitForContractBalance(73, 'PAY514', { minQuantity: '1000' });
            expect(result.quantity).to.equal('1000');
            expect(stub.firstCall.args[1]).to.equal('PAY514');
        });
    });
});
