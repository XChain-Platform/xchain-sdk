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
 *
 * WebSocketClient reconnect catch-up (src/clients/websocket/catch_up.js)
 * against an in-process server that keeps the explorer's catch-up contract:
 * one catch-up per connection, an overlapping one refused with
 * CATCH_UP_IN_PROGRESS carrying the request id, and every catch-up closed by
 * a CATCH_UP_COMPLETE echoing that id. The test answers each catch-up by
 * hand, so it sees exactly when the client sends the next one.
 *
 ********************************************************************/

'use strict';

const { expect }      = require('chai');
const WebSocket       = require('ws');
const WebSocketClient = require('../../../../src/clients/websocket.js');
const { waitFor }     = require('../../../helpers/wait.js');
const { trackCursor } = require('../../../../src/clients/websocket/catch_up.js');
const pump            = require('../../../../src/clients/websocket/message_pump.js');

// A server holding the catch-up latch per connection, as the explorer does.
function createCatchUpServer() {
    return new Promise((resolve) => {
        const srv = { tip: '500', catchUps: [], refusals: [], latched: false, sock: null };
        const wss = new WebSocket.Server({ port: 0 }, () => resolve({ srv, wss, port: wss.address().port }));
        wss.on('connection', (ws) => {
            srv.sock = ws;
            srv.latched = false;
            ws.send(JSON.stringify({ type: 'WELCOME', data: { version: '1', latest_block_index: '9', latest_action_index: srv.tip } }));
            ws.on('message', (raw) => onFrame(srv, ws, JSON.parse(raw.toString())));
        });
        srv.reply = (frame) => srv.sock.send(JSON.stringify(frame));
        // Close catch-up `n` the way the explorer does, releasing the latch.
        srv.complete = (n, latest, truncated, notReplayed) => {
            srv.latched = false;
            const data = { events_replayed: 1, latest_action_index: latest, truncated: !!truncated };
            if (notReplayed) data.not_replayed = notReplayed;
            srv.reply({ type: 'CATCH_UP_COMPLETE', id: srv.catchUps[n].id, data });
        };
        srv.refuse = (n, code) => {
            srv.latched = false;
            srv.reply({ type: 'error', id: srv.catchUps[n].id, data: { code, message: 'refused' } });
        };
    });
}

function onFrame(srv, ws, msg) {
    if (msg.action !== 'subscribe') return;
    ws.send(JSON.stringify({ type: 'SUBSCRIBED', id: msg.id, data: { channel: msg.channels[0] } }));
    const since = msg.params && msg.params.since_action_index;
    if (since === undefined) return;
    if (srv.latched) {
        srv.refusals.push(msg);
        ws.send(JSON.stringify({ type: 'error', id: msg.id, data: { code: 'CATCH_UP_IN_PROGRESS', message: 'busy' } }));
        return;
    }
    srv.latched = true;
    srv.catchUps.push({ id: msg.id, channels: msg.channels, since });
}

function createClient(port) {
    return new WebSocketClient({
        network: 'bitcoin-regtest', websocketUrl: '127.0.0.1', websocketPort: port,
        retry: { maxRetries: 3, baseDelay: 10, maxDelay: 50 }, pingInterval: 60000
    });
}

let ctx, client;

async function reconnectWithTwoActionSubscriptions() {
    client = createClient(ctx.port);
    await client.connect();
    await client.subscribe(['actions']);
    await client.subscribe(['address'], { address: 'X' });
    ctx.srv.tip = '900';
    ctx.srv.sock.close();
    await waitFor(() => ctx.srv.catchUps.length === 1, { timeout: 4000, message: 'no catch-up after reconnect' });
}

describe('WebSocketClient reconnect catch-up: sequencing', function () {
    beforeEach(async function () { ctx = await createCatchUpServer(); });
    afterEach(function (done) { if (client) { client.disconnect(); client = null; } ctx.wss.close(done); });

    it('replays two action subscriptions one at a time from the pre-disconnect cursor, with none refused', async function () {
        await reconnectWithTwoActionSubscriptions();
        expect(ctx.srv.catchUps).to.have.lengthOf(1);
        expect(ctx.srv.catchUps[0]).to.include({ since: '500' });
        expect(ctx.srv.catchUps[0].channels).to.deep.equal(['actions']);
        expect(client.lastActionIndex, 'WELCOME moved the cursor past the gap').to.equal('500');

        ctx.srv.complete(0, '640');
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the second catch-up never went out' });
        expect(ctx.srv.catchUps[1]).to.include({ since: '500' });
        expect(ctx.srv.catchUps[1].channels).to.deep.equal(['address']);

        ctx.srv.complete(1, '610');
        await waitFor(() => client._catchUp === null, { message: 'the catch-up never closed' });
        expect(ctx.srv.refusals).to.have.lengthOf(0);
        expect(client.lastActionIndex).to.equal('640');
    });

    it('resubscribes a blocks subscription at once, without since_action_index', async function () {
        client = createClient(ctx.port);
        await client.connect();
        await client.subscribe(['blocks']);
        await client.subscribe(['actions']);
        const frames = [];
        ctx.srv.sock.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
        client.resubscribe();
        await waitFor(() => ctx.srv.catchUps.length === 1 && frames.some(f => f.channels && f.channels[0] === 'blocks'),
            { message: 'resubscribe did not send both the blocks subscribe and the actions catch-up' });
        const blocks = frames.find(f => f.channels && f.channels[0] === 'blocks');
        expect(blocks.params).to.not.have.property('since_action_index');
        expect(ctx.srv.catchUps).to.have.lengthOf(1);
    });
});

describe('WebSocketClient reconnect catch-up: continuation and refusal', function () {
    beforeEach(async function () { ctx = await createCatchUpServer(); });
    afterEach(function (done) { if (client) { client.disconnect(); client = null; } ctx.wss.close(done); });

    it('continues a truncated replay from where the server stopped', async function () {
        await reconnectWithTwoActionSubscriptions();
        ctx.srv.complete(0, '600', true);
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the truncated replay was not continued' });
        expect(ctx.srv.catchUps[1]).to.include({ since: '600' });
        expect(ctx.srv.catchUps[1].channels).to.deep.equal(['actions']);
        expect(ctx.srv.catchUps[1].id).to.not.equal(ctx.srv.catchUps[0].id);
    });

    it('emits resync_required for a refused catch-up and still replays the next subscription', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('resync_required', (m) => events.push(m.data));
        ctx.srv.refuse(0, 'CATCH_UP_TOO_OLD');
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the next catch-up never went out' });
        expect(events).to.have.lengthOf(1);
        expect(events[0]).to.include({ code: 'CATCH_UP_TOO_OLD', since_action_index: '500' });
        expect(events[0].channels).to.deep.equal(['actions']);
    });

    it('emits not_replayed with the lifecycle types a completed replay could not carry', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('not_replayed', (m) => events.push(m.data));
        ctx.srv.complete(0, '640', false, ['ACTION_REORGED', 'ACTION_DROPPED']);
        await waitFor(() => events.length === 1, { message: 'no not_replayed event' });
        expect(events[0].types).to.deep.equal(['ACTION_REORGED', 'ACTION_DROPPED']);
        expect(events[0].channels).to.deep.equal(['actions']);
        expect(events[0].since_action_index).to.equal('500');
    });

    it('emits no not_replayed event when the list is absent or empty', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('not_replayed', (m) => events.push(m.data));
        ctx.srv.complete(0, '640', false, []);
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the second catch-up never went out' });
        ctx.srv.complete(1, '650');
        await waitFor(() => client._catchUp === null, { message: 'the catch-up never closed' });
        expect(events).to.have.lengthOf(0);
    });

    it('reports an unanswered catch-up as a gap once its timeout passes', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('resync_required', (m) => events.push(m.data));
        client.catchUpTimeoutMs = 20;
        ctx.srv.complete(0, '600', true);
        // Wait for the first event only: the server stays latched on the unanswered
        // continuation, so the queued address catch-up is refused right after it.
        await waitFor(() => events.length >= 1, { message: 'no resync_required after the timeout' });
        expect(events[0].code).to.equal('CATCH_UP_TIMEOUT');
        expect(events[0].since_action_index, 'the gap starts where the truncated replay stopped').to.equal('600');
        expect(events[0].channels).to.deep.equal(['actions']);
    });
});

describe('WebSocketClient reconnect catch-up: which frames move the cursor', function () {

    // Frames whose data.action_index names an entity (a dispenser, a bet feed, an
    // xcall's origin) rather than an action row this client has received.
    const ENTITY_FRAMES = [
        { type: 'SUBSCRIBED',       data: { channel: 'dispenser', action_index: '900000' } },
        { type: 'UNSUBSCRIBED',     data: { channel: 'bet_feed', action_index: '900000' } },
        { type: 'SNAPSHOT',         data: { channel: 'dispenser', action_index: '900000' } },
        { type: 'DISPENSER_UPDATE', data: { channel: 'dispenser', action_index: '900000' } },
        { type: 'BET_CLOSED',       data: { action_index: '900000' } },
        { type: 'XCALL_COMPLETED',  data: { action_index: '900000' } }
    ];

    // A client holding only the cursor state trackCursor reads, with the SDK's own advance rule.
    function cursorClient(cursor, catchUp) {
        const fake = { lastActionIndex: cursor, _catchUp: catchUp || null };
        fake.advanceCursor = pump.advanceCursor.bind(fake);
        return fake;
    }

    it('an idle client ignores entity ids and still advances on NEW_ACTION', function () {
        const fake = cursorClient('500');
        for (const frame of ENTITY_FRAMES) trackCursor(fake, frame);
        expect(fake.lastActionIndex).to.equal('500');
        trackCursor(fake, { type: 'NEW_ACTION', data: { action_index: '510' } });
        expect(fake.lastActionIndex).to.equal('510');
    });

    it('a replay notes NEW_ACTION and CATCH_UP_COMPLETE but not entity ids', function () {
        const replay = { maxSeen: null };
        const fake = cursorClient('500', replay);
        for (const frame of ENTITY_FRAMES) trackCursor(fake, frame);
        expect(replay.maxSeen).to.equal(null);
        trackCursor(fake, { type: 'NEW_ACTION', data: { action_index: '520' } });
        trackCursor(fake, { type: 'CATCH_UP_COMPLETE', data: { latest_action_index: '600' } });
        expect(replay.maxSeen).to.equal('600');
        expect(fake.lastActionIndex).to.equal('500');
    });

    it('a CATCH_UP_COMPLETE outside a replay still advances the cursor', function () {
        const fake = cursorClient('500');
        trackCursor(fake, { type: 'CATCH_UP_COMPLETE', data: { latest_action_index: '640' } });
        expect(fake.lastActionIndex).to.equal('640');
    });
});
