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
 * Regression tests for WebSocketClient under a browser bundler's
 * module-interop wrapper for `ws`.
 *
 * The wallet's browser builds alias the `ws` specifier to an ESM shim
 * (xchain-wallet/packages/core/src/shims/ws-browser.js). Rollup/Vite then hand
 * this CommonJS module an interop wrapper produced by getAugmentedNamespace(),
 * which copies only the ESM namespace KEYS (`default`, `WebSocket`) onto a
 * constructible function. Static class properties (OPEN, CONNECTING,...) are
 * not namespace keys, so they are silently dropped.
 *
 * Before the fix, websocket.js compared `readyState === WebSocket.OPEN`. With
 * that constant undefined the comparison was permanently false, so _send()
 * dropped every frame on a perfectly healthy open socket: no subscription was
 * ever confirmed, every wallet notification channel was dead, and the only
 * symptom was a 10s "No response for request id: sub-N" warning.
 *
 * These tests load websocket.js against the interop wrapper, so they fail on
 * the pre-fix source and pass after it.
 */

'use strict';

const { expect } = require('chai');
const RealWs     = require('ws');

// Bundler interop simulation

// Rollup's getAugmentedNamespace(), reproduced in behaviour: a constructible
// function wrapper that carries the namespace keys and nothing else.
function getAugmentedNamespace(n) {
    if (n.__esModule) return n;
    const f = n.default;
    let a;
    if (typeof f === 'function') {
        a = function a() {
            if (this instanceof a) return Reflect.construct(f, arguments, this.constructor);
            return f.apply(this, arguments);
        };
        a.prototype = f.prototype;
    } else {
        a = {};
    }
    Object.defineProperty(a, '__esModule', { value: true });
    Object.keys(n).forEach(function (k) {
        const d = Object.getOwnPropertyDescriptor(n, k);
        Object.defineProperty(a, k, d.get ? d : { enumerable: true, get: function () { return n[k]; } });
    });
    return a;
}

// The ESM namespace the wallet's ws-browser shim exports, standing the real
// `ws` class in for the browser-only shim class.
function makeBundledWsModule() {
    const namespace = Object.freeze(Object.defineProperty(
        { __proto__: null, WebSocket: RealWs, default: RealWs },
        Symbol.toStringTag,
        { value: 'Module' },
    ));
    return getAugmentedNamespace(namespace);
}

// Load a pristine copy of src/websocket.js while require('ws') resolves to the
// supplied module object. Restores the require cache afterwards so the rest of
// the suite keeps seeing the real `ws`.
function loadClientWithWsModule(wsExports) {
    const wsPath  = require.resolve('ws');
    const clientPath = require.resolve('../../src/websocket.js');
    const savedWs     = require.cache[wsPath];
    const savedClient = require.cache[clientPath];

    require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: wsExports };
    delete require.cache[clientPath];
    try {
        return require('../../src/websocket.js');
    } finally {
        if (savedWs) require.cache[wsPath] = savedWs; else delete require.cache[wsPath];
        delete require.cache[clientPath];
        if (savedClient) require.cache[clientPath] = savedClient;
    }
}

// Mock server: WELCOME on connect, SUBSCRIBED for every subscribe frame

function createMockServer() {
    return new Promise((resolve) => {
        const wss = new RealWs.Server({ port: 0 }, () => {
            wss.on('connection', (ws) => {
                ws.send(JSON.stringify({
                    type: 'WELCOME',
                    timestamp: Date.now(),
                    data: { version: '1.0.0', latest_action_index: 500, channels: ['address'] },
                }));
                ws.on('message', (data) => {
                    const msg = JSON.parse(data.toString());
                    if (msg.action === 'subscribe') {
                        ws.send(JSON.stringify({
                            type: 'SUBSCRIBED',
                            id: msg.id,
                            timestamp: Date.now(),
                            data: { channel: msg.channels[0], active_filters: {} },
                        }));
                    }
                });
            });
            resolve({ wss, port: wss.address().port });
        });
    });
}

// Tests

describe('WebSocketClient bundler interop', function () {

    let server, port, client;

    beforeEach(async function () {
        const s = await createMockServer();
        server = s.wss;
        port   = s.port;
    });

    afterEach(function (done) {
        if (client) { client.disconnect(); client = null; }
        server.close(done);
    });

    function createClient(Klass) {
        return new Klass({
            network: 'bitcoin-regtest',
            websocketUrl: '127.0.0.1',
            websocketPort: port,
            retry: { maxRetries: 0, baseDelay: 100, maxDelay: 200 },
            pingInterval: 60000,
        });
    }

    it('the simulated bundle really does drop the readyState constants', function () {
        const bundled = makeBundledWsModule();
        expect(bundled).to.be.a('function');
        expect(bundled.OPEN).to.be.undefined;
        expect(bundled.CONNECTING).to.be.undefined;
    });

    it('reports isConnected() once open, with no readyState constants on the module', async function () {
        const Klass = loadClientWithWsModule(makeBundledWsModule());
        client = createClient(Klass);
        await client.connect();
        expect(client.isConnected()).to.be.true;
    });

    it('confirms an address subscription (the dead-notifications defect)', async function () {
        const Klass = loadClientWithWsModule(makeBundledWsModule());
        client = createClient(Klass);
        await client.connect();
        const res = await client.subscribe(['address'], { address: 'bcrt1qxc797' });
        expect(res.type).to.equal('SUBSCRIBED');
        expect(res.id).to.equal('sub-1');
    });

    it('actually puts subscribe frames on the wire', async function () {
        const Klass = loadClientWithWsModule(makeBundledWsModule());
        client = createClient(Klass);
        await client.connect();

        const seen = [];
        server.clients.forEach((ws) => ws.on('message', (d) => seen.push(JSON.parse(d.toString()))));

        await client.subscribe(['address'], { address: 'bcrt1qxc797' });
        expect(seen.filter((m) => m.action === 'subscribe')).to.have.lengthOf(1);
    });

    it('does not re-open a second socket when connect() is called twice', async function () {
        const Klass = loadClientWithWsModule(makeBundledWsModule());
        client = createClient(Klass);
        await client.connect();
        const first = client.ws;
        await client.connect();
        expect(client.ws).to.equal(first);
    });

    // The same interop wrapper must not break constructing the socket, and the
    // named/default export forms a bundler may hand back must work too.
    it('resolves the constructor from a non-constructible namespace object', async function () {
        const namespaceOnly = Object.freeze(Object.defineProperty(
            { __proto__: null, WebSocket: RealWs, default: RealWs },
            Symbol.toStringTag,
            { value: 'Module' },
        ));
        const Klass = loadClientWithWsModule(namespaceOnly);
        client = createClient(Klass);
        await client.connect();
        const res = await client.subscribe(['address'], { address: 'bcrt1qxc797' });
        expect(res.type).to.equal('SUBSCRIBED');
    });

    it('still works when require("ws") is the class itself (Node)', async function () {
        const Klass = loadClientWithWsModule(RealWs);
        client = createClient(Klass);
        await client.connect();
        const res = await client.subscribe(['address'], { address: 'bcrt1qxc797' });
        expect(res.type).to.equal('SUBSCRIBED');
    });
});
