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
 * WebSocketClient once-subscription bookkeeping
 * (src/clients/websocket/once_keys.js)
 *
 * The explorer spends a `once` subscription after its first matching frame
 * and sends UNSUBSCRIBED { channel, <entity fields>, reason: 'once' }, the
 * frame built by xchain-explorer src/ws/broadcaster/channels.js
 * removeOnceSubscriptions. A reconnect must not arm a spent key again, an
 * identical subscribe after the spend must send a fresh frame, and the
 * refcount must keep working. Driven against an in-memory socket.
 *
 ********************************************************************/

'use strict';

const { expect }      = require('chai');
const WebSocketClient = require('../../../../src/clients/websocket.js');

const A = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const B = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

const clients = [];

// Unanswered subscribes hold a 10 s response timer; clear them so none outlives the test.
function releaseClients() {
    for (const client of clients.splice(0)) {
        for (const id of Object.keys(client._pending)) {
            clearTimeout(client._pending[id].timeout);
            delete client._pending[id];
        }
    }
}

function makeClient() {
    const client = new WebSocketClient({ network: 'bitcoin-regtest', websocketUrl: '127.0.0.1',
        websocketPort: 1, pingInterval: 60000 });
    clients.push(client);
    const sent = [];
    client.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)), close() {} };
    return { client, sent };
}

// The producer's frame shape: the bare channel, the entity as a sibling field, reason once.
function spend(client, channel, entity) {
    client.onMessage({ type: 'UNSUBSCRIBED', timestamp: 1, data: Object.assign({ channel }, entity, { reason: 'once' }) });
}

function confirm(client, msg) {
    client.onMessage({ type: 'SUBSCRIBED', id: msg.id, data: { channel: msg.channels[0] } });
}

// What a reconnect sends: every frame resubscribe() emits, cursor unset so none is queued.
function replay(client, sent) {
    sent.length = 0;
    client.resubscribe();
    return sent.filter(m => m.action === 'subscribe');
}

describe('WebSocketClient once-subscription spend', function () {
    afterEach(releaseClients);

    it('does not replay a spent single-key once subscription on reconnect', async function () {
        const { client, sent } = makeClient();
        const p = client.subscribe(['address'], { address: A, once: true });
        confirm(client, sent[0]);
        await p;
        spend(client, 'address', { address: A });
        expect(replay(client, sent)).to.deep.equal([]);
    });

    it('replays only the live key of a partly spent multi-key subscription, then nothing', function () {
        const { client, sent } = makeClient();
        client.subscribe(['address'], { addresses: [A, B], once: true, types: ['SEND'] });
        spend(client, 'address', { address: A });
        const frames = replay(client, sent);
        expect(frames).to.have.length(1);
        expect(frames[0].channels).to.deep.equal(['address']);
        expect(frames[0].params).to.deep.equal({ once: true, types: ['SEND'], address: B });
        spend(client, 'address', { address: B });
        expect(replay(client, sent)).to.deep.equal([]);
    });

    it('sends a fresh subscribe when an identical subscribe follows the spend', async function () {
        const { client, sent } = makeClient();
        const first = client.subscribe(['token'], { tick: 'JDOG', once: true });
        confirm(client, sent[0]);
        await first;
        spend(client, 'token', { tick: 'JDOG' });
        sent.length = 0;
        const second = client.subscribe(['token'], { tick: 'JDOG', once: true });
        expect(sent).to.have.length(1);
        expect(sent[0].id).to.not.equal(undefined);
        confirm(client, sent[0]);
        expect((await second).id).to.equal(sent[0].id);
        expect(replay(client, sent)).to.have.length(1);
    });

    it('keeps the second holder live when the first holder unsubscribes after the spend', function () {
        const { client, sent } = makeClient();
        const params = { address: A, once: true };
        client.subscribe(['address'], params);
        spend(client, 'address', { address: A });
        client.subscribe(['address'], params);
        sent.length = 0;
        client.unsubscribe(['address'], params);
        expect(sent.filter(m => m.action === 'unsubscribe')).to.deep.equal([]);
        expect(replay(client, sent)).to.have.length(1);
    });

});

describe('WebSocketClient once-subscription spend matching', function () {
    afterEach(releaseClients);

    it('leaves non-once entries and non-once UNSUBSCRIBED frames alone', function () {
        const { client, sent } = makeClient();
        client.subscribe(['address'], { address: A });
        client.subscribe(['address'], { address: B, once: true });
        spend(client, 'address', { address: A });
        client.onMessage({ type: 'UNSUBSCRIBED', data: { channel: 'address', address: B } });
        client.onMessage({ type: 'UNSUBSCRIBED', data: { channel: 'address', address: B, reason: 'other' } });
        expect(replay(client, sent).map(m => m.params.address)).to.deep.equal([A, B]);
    });

    it('still hands the frame to UNSUBSCRIBED handlers', function () {
        const { client } = makeClient();
        const seen = [];
        client.on('UNSUBSCRIBED', (m) => seen.push(m.data));
        client.subscribe(['address'], { address: A, once: true });
        spend(client, 'address', { address: A });
        expect(seen).to.deep.equal([{ channel: 'address', address: A, reason: 'once' }]);
    });

    it('matches a single-case bech32 address subscribed in upper case to the lowercase frame', function () {
        const { client, sent } = makeClient();
        client.subscribe(['address'], { address: A.toUpperCase(), once: true });
        spend(client, 'address', { address: A });
        expect(replay(client, sent)).to.deep.equal([]);
    });

    it('matches each entity shape the producer names', function () {
        const cases = [
            [['market'], { tick1: 'JDOG', tick2: 'XCHAIN' }, 'market', { tick1: 'JDOG', tick2: 'XCHAIN' }],
            [['dispenser'], { action_index: 7 }, 'dispenser', { action_index: '7' }],
            [['bet_feed'], { action_indexes: ['9'] }, 'bet_feed', { action_index: '9' }],
            [['xcall'], { call_id: 'AB'.repeat(32) }, 'xcall', { call_id: 'ab'.repeat(32) }],
            [['actions'], {}, 'actions', {}],
        ];
        for (const [channels, entity, channel, frame] of cases) {
            const { client, sent } = makeClient();
            client.subscribe(channels, Object.assign({ once: true }, entity));
            spend(client, channel, frame);
            expect(replay(client, sent), channel).to.deep.equal([]);
        }
    });
});

describe('WebSocketClient once-subscription spend during a reconnect replay', function () {
    afterEach(releaseClients);

    it('marks the owning entry when the spend arrives during catch-up', function () {
        const { client, sent } = makeClient();
        client.subscribe(['address'], { addresses: [A, B], once: true });
        spend(client, 'address', { address: A });
        client.lastActionIndex = '100';
        sent.length = 0;
        client.resubscribe();
        const catchUp = sent.find(m => m.params && m.params.since_action_index === '100');
        expect(catchUp.params.address).to.equal(B);
        spend(client, 'address', { address: B });
        client.onMessage({ type: 'CATCH_UP_COMPLETE', id: catchUp.id, data: { events_replayed: 1, latest_action_index: '101' } });
        expect(replay(client, sent)).to.deep.equal([]);
    });

    it('retries a rate-limited split request, but not a key spent meanwhile', async function () {
        const { client, sent } = makeClient();
        client.serverInfo = { limits: { max_message_rate: 1000 } };
        client.subscribe(['address'], { addresses: [A, B], once: true });
        spend(client, 'address', { address: A });
        let frames = replay(client, sent);
        const limited = (m) => client.onMessage({ type: 'error', id: m.id, data: { code: 'RATE_LIMITED', message: 'slow' } });
        limited(frames[0]);
        await new Promise(r => setTimeout(r, 20));
        const retried = sent.filter(m => m.action === 'subscribe' && m.id !== frames[0].id);
        expect(retried.map(m => m.params.address)).to.deep.equal([B]);
        sent.length = 0;
        limited(retried[0]);
        spend(client, 'address', { address: B });
        await new Promise(r => setTimeout(r, 20));
        expect(sent.filter(m => m.action === 'subscribe')).to.deep.equal([]);
    });
});
