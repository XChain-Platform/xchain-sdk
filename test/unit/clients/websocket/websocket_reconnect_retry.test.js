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
 * WebSocketClient reconnect retry (src/clients/websocket/message_pump.js)
 *
 * A reconnect attempt that fails before WELCOME (connection refused) must
 * schedule exactly one further attempt, so the client keeps retrying until it
 * reconnects or reaches maxRetries and emits 'connection_lost'. It must never
 * be left disconnected with no event. Runs against an in-process ws server;
 * jitter is pinned to zero and delays are a few ms.
 *
 ********************************************************************/

'use strict';

const { expect }      = require('chai');
const sinon           = require('sinon');
const net             = require('net');
const WebSocket       = require('ws');
const WebSocketClient = require('../../../../src/clients/websocket.js');
const { waitFor }     = require('../../../helpers/wait.js');

function createServer() {
    return new Promise((resolve) => {
        const subs = [];
        const wss = new WebSocket.Server({ port: 0 }, () => resolve({ wss, port: wss.address().port, subs }));
        wss.on('connection', (ws) => {
            ws.send(JSON.stringify({ type: 'WELCOME', data: { version: '1', latest_block_index: '1', latest_action_index: '1' } }));
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.action === 'subscribe') {
                    subs.push(msg);
                    ws.send(JSON.stringify({ type: 'SUBSCRIBED', id: msg.id, data: { channel: msg.channels[0], active_filters: {} } }));
                }
            });
        });
    });
}

// A port nothing listens on.
function closedPort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

function makeClient(port, retry, hooks) {
    return new WebSocketClient({
        explorerUrl: '127.0.0.1', explorerPort: port, network: 'bitcoin-regtest',
        retry: Object.assign({ baseDelay: 5, maxDelay: 10 }, retry), hooks, pingInterval: 60000
    });
}

describe('WebSocketClient reconnect retry', function () {
    let server, client, deadPort;

    beforeEach(async () => {
        sinon.stub(Math, 'random').returns(0);
        server = await createServer();
        deadPort = await closedPort();
    });

    afterEach(async () => {
        Math.random.restore();
        if (client) client.disconnect();
        client = null;
        for (const c of server.wss.clients) c.terminate();
        await new Promise(r => server.wss.close(r));
    });

    it('keeps retrying after one failed attempt and reconnects once the server is back', async () => {
        const attempts = [];
        let client_;
        client = client_ = makeClient(server.port, { maxRetries: 10 }, {
            onWsReconnect: (e) => {
                attempts.push(e.attempt);
                // The first attempt dials a closed port; restore the port after it fails.
                if (e.attempt === 1) {
                    client_.port = deadPort;
                    setTimeout(() => { client_.port = server.port; }, 40);
                }
            }
        });
        await client.connect();
        client.subscribe('blocks');
        await waitFor(() => server.subs.length === 1, { message: 'initial subscribe' });

        client.port = deadPort;
        client.ws.terminate();

        await waitFor(() => client.isConnected(), { timeout: 3000, message: 'client never reconnected after a failed attempt' });
        expect(attempts.length).to.be.greaterThan(1);
        await waitFor(() => server.subs.length >= 2, { message: 'subscription not replayed' });
    });

    it('emits connection_lost exactly once after maxRetries failed attempts', async () => {
        const attempts = [];
        client = makeClient(server.port, { maxRetries: 2 }, { onWsReconnect: (e) => attempts.push(e.attempt) });
        const lost = sinon.spy();
        client.on('connection_lost', lost);
        await client.connect();

        client.port = deadPort;
        client.ws.terminate();

        await waitFor(() => lost.callCount >= 1, { timeout: 3000, message: 'connection_lost never emitted' });
        await new Promise(r => setTimeout(r, 100));
        expect(attempts).to.deep.equal([1, 2]);
        expect(lost.callCount).to.equal(1);
        expect(client.isConnected()).to.equal(false);
    });

    it('schedules no further attempt after an intentional disconnect', async () => {
        const attempts = [];
        let client_;
        client = client_ = makeClient(server.port, { maxRetries: 10 }, {
            onWsReconnect: (e) => { attempts.push(e.attempt); client_.disconnect(); }
        });
        const lost = sinon.spy();
        client.on('connection_lost', lost);
        await client.connect();

        client.port = deadPort;
        client.ws.terminate();

        await waitFor(() => attempts.length === 1);
        await new Promise(r => setTimeout(r, 150));
        expect(attempts).to.deep.equal([1]);
        expect(lost.callCount).to.equal(0);
    });
});
