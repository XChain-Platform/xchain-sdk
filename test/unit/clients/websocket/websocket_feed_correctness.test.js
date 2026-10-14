/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The SDK's copy of the explorer client loop against the feed corrections
 * (explorer WS-03, WS-05, WS-08): a reconnect never sends faster than the
 * server's message rate, a subscribe or catch-up the server drops with
 * RATE_LIMITED is sent again, a REORG frame moves the cursor below the
 * rollback, and a CATCH_UP_REORGED refusal surfaces its fork fields.
 *
 ********************************************************************/

'use strict';

const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketClient = require('../../../../src/clients/websocket.js');

let clock;

// A client on an open fake socket that records each frame with the fake clock's time.
function openClient(options) {
    const client = new WebSocketClient(Object.assign({ network: 'bitcoin-regtest', pingInterval: 60000 }, options || {}));
    client.sentAt = [];
    client.ws = { readyState: 1, send: (raw) => client.sentAt.push({ at: Date.now(), msg: JSON.parse(raw) }), close() {} };
    client.connected = true;
    return client;
}

const subscribes = (client) => client.sentAt.filter((s) => s.msg.action === 'subscribe');

// The explorer's leaky bucket over the recorded sends: how many it would refuse.
function overRate(sends, rate) {
    let level = 0, last = null, refused = 0;
    for (const s of sends) {
        if (last !== null) level = Math.max(0, level - ((s.at - last) / 1000) * rate);
        last = s.at;
        level += 1;
        if (level > rate) refused++;
    }
    return refused;
}

function track(client, n) {
    for (let i = 0; i < n; i++) client._subscriptions.push({ key: 'k' + i, channels: ['token'], params: { tick: 'T' + i }, refs: 1 });
}

// Each block runs on a fake clock, so pacing and retry intervals are driven by hand.
function onFakeClock() {
    beforeEach(() => { clock = sinon.useFakeTimers({ now: 1000000 }); });
    afterEach(() => { clock.restore(); sinon.restore(); });
}

describe('WebSocketClient feed corrections, WS-03: paced resubscribe', function () {
    onFakeClock();

    it('sends a 25-subscription reconnect without exceeding the server rate, and sends all of it', function () {
        const client = openClient();
        track(client, 25);
        client.resubscribe();
        expect(subscribes(client).length).to.be.lessThan(10);
        clock.tick(5000);

        expect(subscribes(client)).to.have.lengthOf(25);
        expect(overRate(client.sentAt, 10)).to.equal(0);
    });

    it('paces to the rate WELCOME advertises', function () {
        const client = openClient();
        client.onMessage({ type: 'WELCOME', data: { version: '1', latest_block_index: '1', latest_action_index: '0', limits: { max_message_rate: 4 } } });
        track(client, 12);
        client.resubscribe();
        clock.tick(6000);

        expect(subscribes(client)).to.have.lengthOf(12);
        expect(overRate(client.sentAt, 4)).to.equal(0);
    });
});

describe('WebSocketClient feed corrections, WS-03: RATE_LIMITED retry', function () {
    onFakeClock();

    it('sends a resubscribe again when the server drops it with RATE_LIMITED naming its id', function () {
        const client = openClient();
        track(client, 2);
        client.resubscribe();
        const dropped = subscribes(client)[1].msg;
        expect(dropped.id).to.be.a('string');
        client.onMessage({ type: 'error', id: dropped.id, data: { code: 'RATE_LIMITED', message: 'slow down' } });
        clock.tick(1000);

        const again = subscribes(client).slice(2);
        expect(again).to.have.lengthOf(1);
        expect(again[0].msg.params).to.deep.equal(dropped.params);
    });

    it('sends a subscribe() request again under its id, so the caller still gets its SUBSCRIBED', async function () {
        const client = openClient();
        const pending = client.subscribe(['actions']);
        const first = subscribes(client)[0].msg;
        client.onMessage({ type: 'error', id: first.id, data: { code: 'RATE_LIMITED', message: 'slow down' } });
        clock.tick(1000);
        expect(subscribes(client)).to.have.lengthOf(2);
        expect(subscribes(client)[1].msg.id).to.equal(first.id);
        client.onMessage({ type: 'SUBSCRIBED', id: first.id, data: { channel: 'actions' } });
        const answer = await pending;
        expect(answer.type).to.equal('SUBSCRIBED');
    });

    it('sends a catch-up again on RATE_LIMITED instead of emitting resync_required', function () {
        const client = openClient();
        const events = [];
        client.on('resync_required', (m) => events.push(m.data));
        client.lastActionIndex = '500';
        client._subscriptions.push({ key: 'a', channels: ['actions'], params: {}, refs: 1 });
        client.resubscribe();
        const first = subscribes(client)[0].msg;
        client.onMessage({ type: 'error', id: first.id, data: { code: 'RATE_LIMITED', message: 'slow down' } });
        clock.tick(1000);

        expect(events).to.have.lengthOf(0);
        expect(subscribes(client)[1].msg.params.since_action_index).to.equal('500');
    });
});

describe('WebSocketClient feed corrections, WS-04: an unseeded coin', function () {
    onFakeClock();

    it('sends a catch-up again after a second on CATCH_UP_NOT_READY', function () {
        const client = openClient();
        const events = [];
        client.on('resync_required', (m) => events.push(m.data));
        client.lastActionIndex = '500';
        client._subscriptions.push({ key: 'a', channels: ['actions'], params: {}, refs: 1 });
        client.resubscribe();
        const first = subscribes(client)[0].msg;
        client.onMessage({ type: 'error', id: first.id, data: { code: 'CATCH_UP_NOT_READY', message: 'retry shortly' } });
        clock.tick(500);
        expect(subscribes(client)).to.have.lengthOf(1);
        clock.tick(600);

        expect(events).to.have.lengthOf(0);
        expect(subscribes(client)[1].msg.params.since_action_index).to.equal('500');
    });
});

describe('WebSocketClient feed corrections, WS-05 and WS-01: rollbacks', function () {
    onFakeClock();

    it('drops the cursor below a REORG frame\'s first invalidated index, then follows the replacements', function () {
        const client = openClient();
        client.lastActionIndex = '130';
        client.onMessage({ type: 'REORG', data: { fork_block_index: '11', first_invalid_action_index: '101' } });
        expect(client.lastActionIndex).to.equal('100');
        client.onMessage({ type: 'NEW_ACTION', data: { action_index: '105' } });
        expect(client.lastActionIndex).to.equal('105');
    });

    it('surfaces CATCH_UP_REORGED as resync_required with the fork fields', function () {
        const client = openClient();
        const events = [];
        client.on('resync_required', (m) => events.push(m.data));
        client.lastActionIndex = '120';
        client._subscriptions.push({ key: 'a', channels: ['actions'], params: {}, refs: 1 });
        client.resubscribe();
        const first = subscribes(client)[0].msg;
        client.onMessage({ type: 'error', id: first.id, data: { code: 'CATCH_UP_REORGED', message: 'resync',
            fork_block_index: '11', first_invalid_action_index: '101' } });

        expect(events).to.have.lengthOf(1);
        expect(events[0]).to.include({ code: 'CATCH_UP_REORGED', fork_block_index: '11', first_invalid_action_index: '101', since_action_index: '120' });
    });
});

describe('WebSocketClient feed corrections, WS-08: blocks', function () {
    onFakeClock();

    it('sends a blocks subscription with the cursor, so its COMPLETE can say NEW_BLOCK is not replayed', function () {
        const client = openClient();
        const notes = [];
        client.on('not_replayed', (m) => notes.push(m.data));
        client.lastActionIndex = '500';
        client._subscriptions.push({ key: 'b', channels: ['blocks'], params: {}, refs: 1 });
        client.resubscribe();
        const first = subscribes(client)[0].msg;
        expect(first.params.since_action_index).to.equal('500');
        client.onMessage({ type: 'CATCH_UP_COMPLETE', id: first.id, data: { events_replayed: 0, latest_action_index: '500', truncated: false, not_replayed: ['NEW_BLOCK'] } });
        expect(notes.map((n) => n.types)).to.deep.equal([['NEW_BLOCK']]);
    });
});
