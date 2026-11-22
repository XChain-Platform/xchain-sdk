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
        srv.complete = (n, latest, truncated, notReplayed, stale) => {
            srv.latched = false;
            const data = { events_replayed: 1, latest_action_index: latest, truncated: !!truncated };
            if (notReplayed) data.not_replayed = notReplayed;
            srv.reply({ type: 'CATCH_UP_COMPLETE', id: srv.catchUps[n].id, ...(stale ? { stale: true } : {}), data });
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

    // A blocks subscription goes through the catch-up queue with the cursor, so its
    // CATCH_UP_COMPLETE can name NEW_BLOCK as not replayed; it is still one at a time.
    it('resubscribes a blocks subscription through the catch-up queue, so it hears NEW_BLOCK is not replayed', async function () {
        client = createClient(ctx.port);
        await client.connect();
        await client.subscribe(['blocks']);
        await client.subscribe(['actions']);
        const notes = [];
        client.on('not_replayed', (m) => notes.push(m.data));
        client.resubscribe();
        await waitFor(() => ctx.srv.catchUps.length === 1, { message: 'the blocks catch-up never went out' });
        expect(ctx.srv.catchUps[0].channels).to.deep.equal(['blocks']);
        expect(ctx.srv.catchUps[0]).to.include({ since: '500' });
        // Answer it with a NEW_BLOCK note, freeing the mock server's one-catch-up latch.
        ctx.srv.latched = false;
        ctx.srv.reply({ type: 'CATCH_UP_COMPLETE', id: ctx.srv.catchUps[0].id,
            data: { events_replayed: 0, latest_action_index: '500', truncated: false, not_replayed: ['NEW_BLOCK'] } });
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the actions catch-up never followed' });
        expect(ctx.srv.catchUps[1].channels).to.deep.equal(['actions']);
        expect(notes.map(n => [n.types, n.channels])).to.deep.equal([[['NEW_BLOCK'], ['blocks']]]);
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

describe('WebSocketClient reconnect catch-up: a stale replica', function () {
    beforeEach(async function () { ctx = await createCatchUpServer(); });
    afterEach(function (done) { if (client) { client.disconnect(); client = null; } ctx.wss.close(done); });

    it('emits stale_replay for a replay closed stale, and still advances the cursor to the rows delivered', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('stale_replay', (m) => events.push(m.data));
        ctx.srv.complete(0, '640', false, null, true);
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the second catch-up never went out' });
        ctx.srv.complete(1, '610');
        await waitFor(() => client._catchUp === null, { message: 'the catch-up never closed' });
        expect(events).to.deep.equal([{ channels: ['actions'], since_action_index: '500', latest_action_index: '640' }]);
        expect(client.lastActionIndex).to.equal('640');
    });

    it('emits stale_replay once for a stale replay continued past a truncated round', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('stale_replay', (m) => events.push(m.data));
        ctx.srv.complete(0, '600', true, null, true);
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the truncated replay was not continued' });
        ctx.srv.complete(1, '650', false, null, true);
        await waitFor(() => ctx.srv.catchUps.length === 3, { message: 'the address catch-up never went out' });
        expect(events).to.have.lengthOf(1);
        expect(events[0]).to.include({ since_action_index: '600', latest_action_index: '650' });
    });

    it('emits no stale_replay for a replay closed fresh', async function () {
        const events = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('stale_replay', (m) => events.push(m.data));
        ctx.srv.complete(0, '640');
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the second catch-up never went out' });
        ctx.srv.complete(1, '650');
        await waitFor(() => client._catchUp === null, { message: 'the catch-up never closed' });
        expect(events).to.have.lengthOf(0);
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

const ROWS = ['151', '152'];

// Send the replayed rows of catch-up `n` the way the explorer does: every row above the
// request's since_action_index (or every row, for a server that ignores it), each with
// catch_up: true, then the CATCH_UP_COMPLETE.
function replay(n, rows, ignoreSince) {
    const since = BigInt(ctx.srv.catchUps[n].since);
    const sent  = rows.filter(r => ignoreSince || BigInt(r) > since);
    for (const r of sent) ctx.srv.reply({ type: 'NEW_ACTION', catch_up: true, data: { action_index: r } });
    ctx.srv.complete(n, sent.length > 0 ? sent[sent.length - 1] : ctx.srv.catchUps[n].since);
}

// Connect at cursor 150 with one subscription and a NEW_ACTION handler (what onAction and
// onAddress register), then drop so the first catch-up goes out from 150.
async function connectAndDrop(channels, params) {
    ctx.srv.tip = '150';
    client = createClient(ctx.port);
    const seen = [];
    const gaps = [];
    client.on('NEW_ACTION', (m) => seen.push(m.data.action_index));
    client.on('resync_required', (m) => gaps.push(m.data));
    await client.connect();
    await client.subscribe(channels, params);
    ctx.srv.tip = '152';
    ctx.srv.sock.close();
    await waitFor(() => ctx.srv.catchUps.length === 1, { timeout: 4000, message: 'no catch-up after the first drop' });
    expect(ctx.srv.catchUps[0]).to.include({ since: '150' });
    return { seen, gaps };
}

// Deliver row 151 of the first replay, then drop again while that replay is still open.
async function dropAfterFirstRow(seen) {
    ctx.srv.reply({ type: 'NEW_ACTION', catch_up: true, data: { action_index: '151' } });
    await waitFor(() => seen.length === 1, { message: 'the first replayed row never arrived' });
    expect(client._catchUp, 'the replay is still open at the drop').to.not.equal(null);
    ctx.srv.sock.close();
    await waitFor(() => ctx.srv.catchUps.length === 2, { timeout: 4000, message: 'no catch-up after the second drop' });
}

describe('WebSocketClient reconnect catch-up: a drop in the middle of a replay', function () {
    beforeEach(async function () { ctx = await createCatchUpServer(); });
    afterEach(function (done) { if (client) { client.disconnect(); client = null; } ctx.wss.close(done); });

    for (const [label, channels, params] of [['actions', ['actions'], undefined], ['address', ['address'], { address: 'X' }]]) {
        it('delivers every row once on the ' + label + ' channel, resuming after the row already dispatched', async function () {
            const { seen, gaps } = await connectAndDrop(channels, params);
            await dropAfterFirstRow(seen);
            expect(ctx.srv.catchUps[1].channels).to.deep.equal(channels);
            expect(ctx.srv.catchUps[1]).to.include({ since: '151' });
            replay(1, ROWS);
            await waitFor(() => client._catchUp === null, { message: 'the second catch-up never closed' });
            expect(seen).to.deep.equal(['151', '152']);
            expect(new Set(seen).size).to.equal(seen.length);
            expect(client.lastActionIndex).to.equal('152');
            expect(client._subscriptions[0], 'the closed catch-up clears its mark').to.not.have.property('replayedTo');
            expect(gaps).to.have.lengthOf(0);
        });
    }

    it('drops a replayed row the subscription already dispatched when the server sends it again', async function () {
        const { seen, gaps } = await connectAndDrop(['actions']);
        await dropAfterFirstRow(seen);
        replay(1, ROWS, true);
        await waitFor(() => client._catchUp === null, { message: 'the second catch-up never closed' });
        expect(seen).to.deep.equal(['151', '152']);
        expect(client.lastActionIndex).to.equal('152');
        expect(gaps).to.have.lengthOf(0);
    });
});

describe('WebSocketClient reconnect catch-up: rows a replay mark must not hide', function () {
    beforeEach(async function () { ctx = await createCatchUpServer(); });
    afterEach(function (done) { if (client) { client.disconnect(); client = null; } ctx.wss.close(done); });

    it('still delivers rows never dispatched before the drop', async function () {
        const { seen, gaps } = await connectAndDrop(['actions']);
        ctx.srv.sock.close();
        await waitFor(() => ctx.srv.catchUps.length === 2, { timeout: 4000, message: 'no catch-up after the second drop' });
        expect(ctx.srv.catchUps[1]).to.include({ since: '150' });
        replay(1, ROWS);
        await waitFor(() => client._catchUp === null, { message: 'the second catch-up never closed' });
        expect(seen).to.deep.equal(['151', '152']);
        expect(client.lastActionIndex).to.equal('152');
        expect(gaps).to.have.lengthOf(0);
    });

    it('delivers a replacement row again after a REORG voids a row the replay dispatched', async function () {
        const { seen } = await connectAndDrop(['actions']);
        ctx.srv.reply({ type: 'NEW_ACTION', catch_up: true, data: { action_index: '151' } });
        await waitFor(() => seen.length === 1, { message: 'the first replayed row never arrived' });
        ctx.srv.reply({ type: 'REORG', data: { first_invalid_action_index: '151' } });
        await waitFor(() => client._subscriptions[0].replayedTo === '150', { message: 'the REORG did not lower the mark' });
        ctx.srv.sock.close();
        await waitFor(() => ctx.srv.catchUps.length === 2, { timeout: 4000, message: 'no catch-up after the second drop' });
        expect(ctx.srv.catchUps[1]).to.include({ since: '150' });
        replay(1, ROWS);
        await waitFor(() => client._catchUp === null, { message: 'the second catch-up never closed' });
        expect(seen).to.deep.equal(['151', '151', '152']);
        expect(client.lastActionIndex).to.equal('152');
    });

    // A late row from a timed-out replay cannot be pinned to a subscription, so it raises no
    // replay mark that could skip rows on the next reconnect.
    it('raises no replay mark from a row arriving after a catch-up timed out', async function () {
        const seen = [];
        await reconnectWithTwoActionSubscriptions();
        client.on('NEW_ACTION', (m) => seen.push(m.data.action_index));
        client.catchUpTimeoutMs = 300;
        ctx.srv.complete(0, '600', true);
        await waitFor(() => ctx.srv.catchUps.length === 2, { message: 'the truncated replay was not continued' });
        ctx.srv.latched = false;
        await waitFor(() => ctx.srv.catchUps.length === 3, { message: 'the timeout never moved the queue on' });
        ctx.srv.reply({ type: 'NEW_ACTION', catch_up: true, data: { action_index: '601' } });
        await waitFor(() => seen.length === 1, { message: 'the late replayed row never arrived' });
        expect(client._subscriptions.map(s => s.replayedTo)).to.deep.equal([undefined, undefined]);
    });
});
