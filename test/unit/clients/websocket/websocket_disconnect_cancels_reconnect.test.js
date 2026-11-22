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
 * WebSocketClient disconnect() during a pending reconnect
 *
 * An intentional disconnect() must leave no live handle behind: a reconnect
 * timer that is waiting out its backoff is cancelled, and a reconnect attempt
 * already inside connect() (awaiting the readiness hook) must not open a
 * socket or resubscribe afterwards.
 *
 ********************************************************************/

'use strict';

const { expect }      = require('chai');
const sinon           = require('sinon');
const WebSocket       = require('ws');
const WebSocketClient = require('../../../../src/clients/websocket.js');
const { waitFor }     = require('../../../helpers/wait.js');

function createServer() {
    return new Promise((resolve) => {
        const subs = [];
        let connections = 0;
        const wss = new WebSocket.Server({ port: 0 }, () => resolve({
            wss, port: wss.address().port, subs, get connections() { return connections; }
        }));
        wss.on('connection', (ws) => {
            connections++;
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('WebSocketClient disconnect cancels a pending reconnect', function () {
    let server, client, readyHook;

    beforeEach(async () => {
        sinon.stub(Math, 'random').returns(0);
        server = await createServer();
        readyHook = null;
        client = new WebSocketClient({
            explorerUrl: '127.0.0.1', explorerPort: server.port, network: 'bitcoin-regtest',
            retry: { baseDelay: 60, maxDelay: 60 }, pingInterval: 60000,
            readyHook: () => (readyHook ? readyHook() : undefined)
        });
    });

    afterEach(async () => {
        Math.random.restore();
        client.disconnect();
        for (const c of server.wss.clients) c.terminate();
        await new Promise(r => server.wss.close(r));
    });

    async function connectAndDrop() {
        await client.connect();
        client.subscribe('actions');
        await waitFor(() => server.subs.length === 1, { message: 'initial subscribe' });
        client.ws.terminate();
        await waitFor(() => client.reconnectAttempts === 1, { message: 'reconnect never scheduled' });
    }

    it('does not reconnect or resubscribe when disconnect() runs during the backoff delay', async () => {
        await connectAndDrop();
        const connects = server.connections;
        client.disconnect();
        expect(client._reconnectTimer).to.equal(null);
        await sleep(300);
        expect(server.connections).to.equal(connects);
        expect(server.subs.length).to.equal(1);
        expect(client.intentionalClose).to.equal(true);
        expect(client.connected).to.equal(false);
        expect(client.ws).to.equal(null);
    });

    it('does not open a socket or resubscribe when disconnect() runs while the attempt awaits the readiness hook', async () => {
        await connectAndDrop();
        const connects = server.connections;
        let release;
        readyHook = () => new Promise((r) => { release = r; });
        await waitFor(() => !!release, { message: 'reconnect never reached the readiness hook' });
        client.disconnect();
        release();
        await sleep(300);
        expect(server.connections).to.equal(connects);
        expect(server.subs.length).to.equal(1);
        expect(client.intentionalClose).to.equal(true);
        expect(client.connected).to.equal(false);
        expect(client.ws).to.equal(null);
    });
});
