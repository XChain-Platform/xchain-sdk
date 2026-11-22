// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { waitForCalls } = require('../../../../helpers/wait.js');
const { canonicalSubscriptionAddress } = require('../../../../../src/XChainSDK/event_frames.js');
const { closeFixture, createFixture, passBarrier } = require('./support/setup.js');

const LOWER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const UPPER = LOWER.toUpperCase();

let server;
let sdk;

function registerCanonicalizationTest() {
    it('canonicalizes only checksum-valid bech32 addresses', function () {
        expect(canonicalSubscriptionAddress(UPPER)).to.equal(LOWER);
        expect(canonicalSubscriptionAddress('1AbC')).to.equal('1AbC');
        expect(canonicalSubscriptionAddress('C:BTC:0')).to.equal('C:BTC:0');
        expect(canonicalSubscriptionAddress('bC1invalid')).to.equal('bC1invalid');
    });
}

function registerAddressFrameTest() {
    it('delivers lowercase snapshot and live frames to an uppercase subscriber', async function () {
        const spy = sinon.spy();
        sdk.onAddress(UPPER, spy, { snapshot: true });
        server._lastClient.send(JSON.stringify({
            type: 'SNAPSHOT', data: { channel: 'address', address: LOWER, balances: [] }
        }));
        server._lastClient.send(JSON.stringify({
            type: 'ADDRESS_UPDATE', data: { address: LOWER, balances: [] }
        }));
        server._lastClient.send(JSON.stringify({
            type: 'NEW_ACTION', data: { source: '1other', destinations: [LOWER] }
        }));
        await waitForCalls(spy, 3);
        expect(spy.callCount).to.equal(3);
    });
}

function registerSharedSubscriptionTest() {
    it('shares one lowercase subscription across address spellings', function () {
        const stopUpper = sdk.onAddress(UPPER, sinon.spy());
        const stopLower = sdk.onAddress(LOWER, sinon.spy());
        const subscriptions = sdk.ws._subscriptions.filter((entry) =>
            entry.channels.includes('address') && entry.params.address === LOWER);
        expect(subscriptions).to.have.lengthOf(1);
        stopUpper();
        expect(sdk.ws._subscriptions).to.have.lengthOf(1);
        stopLower();
        expect(sdk.ws._subscriptions.filter((entry) => entry.channels.includes('address')))
            .to.have.lengthOf(0);
    });
}

function registerShortcutTest() {
    it('delivers lowercase frames through each address shortcut', async function () {
        const mempool = sinon.spy();
        const coinpay = sinon.spy();
        const order = sinon.spy();
        sdk.onMempoolAction(UPPER, mempool);
        sdk.onCoinpayRequired(UPPER, coinpay);
        sdk.onOrderMatch(UPPER, order);
        server._lastClient.send(JSON.stringify({
            type: 'MEMPOOL_ACTION', data: { source: LOWER, destinations: [] }
        }));
        server._lastClient.send(JSON.stringify({
            type: 'COINPAY_REQUIRED', data: { payer_address: LOWER }
        }));
        server._lastClient.send(JSON.stringify({
            type: 'ORDER_MATCH', data: { payee_address: LOWER }
        }));
        await Promise.all([
            waitForCalls(mempool), waitForCalls(coinpay), waitForCalls(order),
        ]);
        expect(mempool.calledOnce).to.equal(true);
        expect(coinpay.calledOnce).to.equal(true);
        expect(order.calledOnce).to.equal(true);
    });
}

function registerOtherAddressTest() {
    it('still rejects a lowercase frame for another address', async function () {
        const spy = sinon.spy();
        sdk.onAddress(UPPER, spy);
        server._lastClient.send(JSON.stringify({
            type: 'ADDRESS_UPDATE',
            data: { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', balances: [] },
        }));
        await passBarrier(sdk, server);
        expect(spy.called).to.equal(false);
    });
}

describe('uppercase bech32 address subscriptions', function () {
    beforeEach(async function () {
        ({ server, sdk } = await createFixture());
        await sdk.connectWs();
    });

    afterEach(function (done) {
        closeFixture(sdk, server, done);
    });

    registerCanonicalizationTest();
    registerAddressFrameTest();
    registerSharedSubscriptionTest();
    registerShortcutTest();
    registerOtherAddressTest();
});
