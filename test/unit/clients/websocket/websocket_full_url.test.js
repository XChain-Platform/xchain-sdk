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
 * Unit tests for how WebSocketClient turns its base into a dial URL.
 *
 * A base that already carries a scheme (ws://, wss://, http://, https://)
 * is a full URL and is used as given, with no port added; only a bare host
 * gets the protocol and port. The dialled URL is read off a recording `ws`
 * stand-in, and the ws:// case also connects to a real local server.
 */

'use strict';

const { expect } = require('chai');
const RealWs     = require('ws');
const WebSocketClient = require('../../../../src/clients/websocket.js');
const XChainSDK  = require('../../../../src/XChainSDK.js');
const { hasWsScheme, isSecureUrl } = require('../../../../src/utils/endpoints.js');

// Load a fresh copy of src/clients/websocket.js whose `ws` is a class that only
// records the URL it was asked to dial, then restore the require cache.
function loadRecordingClient(seen) {
    class RecordingWs {
        constructor(url) { seen.push(url); this.readyState = 0; }
        on() {}
        close() {}
    }
    const wsPath     = require.resolve('ws');
    const clientPath = require.resolve('../../../../src/clients/websocket.js');
    const constPath  = require.resolve('../../../../src/clients/websocket/socket_constants.js');
    const saved = { ws: require.cache[wsPath], client: require.cache[clientPath], consts: require.cache[constPath] };

    require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: RecordingWs };
    delete require.cache[clientPath];
    delete require.cache[constPath];
    try {
        return require('../../../../src/clients/websocket.js');
    } finally {
        if (saved.ws) require.cache[wsPath] = saved.ws; else delete require.cache[wsPath];
        delete require.cache[clientPath];
        delete require.cache[constPath];
        if (saved.client) require.cache[clientPath] = saved.client;
        if (saved.consts) require.cache[constPath] = saved.consts;
    }
}

// The URL a mainnet BTC client built from `opts` dials on connect().
function dialledUrl(opts) {
    const seen  = [];
    const Klass = loadRecordingClient(seen);
    const client = new Klass(Object.assign({ network: 'bitcoin-mainnet', retry: { maxRetries: 0 } }, opts));
    client.connect().catch(() => {});
    return new Promise((resolve) => setImmediate(() => resolve(seen[0])));
}

describe('WebSocketClient full-URL bases', function () {

    it('uses a wss:// base as given, with no port added', async function () {
        expect(await dialledUrl({ websocketUrl: 'wss://h' })).to.equal('wss://h/BTC/api/websocket');
    });

    it('strips a trailing slash from a wss:// base', async function () {
        expect(await dialledUrl({ websocketUrl: 'wss://h/' })).to.equal('wss://h/BTC/api/websocket');
    });

    it('keeps the port written into a ws:// base and adds none', async function () {
        expect(await dialledUrl({ websocketUrl: 'ws://127.0.0.1:9000', websocketPort: 3007 }))
            .to.equal('ws://127.0.0.1:9000/BTC/api/websocket');
    });

    it('still maps an https:// base to wss://', async function () {
        expect(await dialledUrl({ websocketUrl: 'https://h' })).to.equal('wss://h/BTC/api/websocket');
    });

    it('still gives a bare host the protocol and default port', async function () {
        expect(await dialledUrl({ websocketUrl: '127.0.0.1' })).to.equal('ws://127.0.0.1:8080/BTC/api/websocket');
    });

    it('treats a bare host that starts with wss as a host, not a URL', async function () {
        expect(await dialledUrl({ websocketUrl: 'wss-gw.internal' })).to.equal('ws://wss-gw.internal:8080/BTC/api/websocket');
    });
});

describe('WebSocketClient full-URL bases', function () {
    let server, port, client;

    beforeEach(function (done) {
        server = new RealWs.Server({ port: 0 }, () => {
            port = server.address().port;
            server.on('connection', (ws) => {
                ws.send(JSON.stringify({ type: 'WELCOME', timestamp: Date.now(), data: { version: '1.0.0' } }));
            });
            done();
        });
    });

    afterEach(function (done) {
        if (client) { client.disconnect(); client = null; }
        server.close(done);
    });

    it('connects to a local server given as a ws:// URL', async function () {
        client = new WebSocketClient({
            network: 'bitcoin-regtest',
            websocketUrl: 'ws://127.0.0.1:' + port,
            retry: { maxRetries: 0 },
            pingInterval: 60000
        });
        await client.connect();
        expect(client.isConnected()).to.be.true;
    });
});

describe('endpoints websocket scheme detection', function () {

    it('hasWsScheme needs the scheme separator, not just a ws prefix', function () {
        expect(hasWsScheme('ws://a')).to.equal(true);
        expect(hasWsScheme('wss://a')).to.equal(true);
        expect(hasWsScheme('wss-gw.internal')).to.equal(false);
        expect(hasWsScheme('http://a')).to.equal(false);
        expect(hasWsScheme(null)).to.equal(false);
    });

    it('isSecureUrl accepts https:// and wss:// only', function () {
        expect(isSecureUrl('https://a')).to.equal(true);
        expect(isSecureUrl('wss://a')).to.equal(true);
        expect(isSecureUrl('http://a')).to.equal(false);
        expect(isSecureUrl('ws://a')).to.equal(false);
        expect(isSecureUrl('httpsevil.example')).to.equal(false);
        expect(isSecureUrl(undefined)).to.equal(false);
    });
});

describe('isDowngrade with a wss:// websocket base', function () {
    let sdk;
    beforeEach(function () { sdk = new XChainSDK({}); });

    it('blocks hub discovery replacing a wss:// websocket base with an http endpoint', function () {
        expect(sdk.isDowngrade('websocket', { baseUrl: 'wss://h' }, 'http://127.0.0.1:8080')).to.equal(true);
    });

    it('blocks hub discovery replacing a wss:// websocket base with a bare host', function () {
        expect(sdk.isDowngrade('websocket', { baseUrl: 'wss://h' }, '127.0.0.1')).to.equal(true);
    });

    it('lets hub discovery move a wss:// websocket base to an https explorer', function () {
        expect(sdk.isDowngrade('websocket', { baseUrl: 'wss://a' }, 'https://b')).to.equal(false);
    });

    it('still refuses a wss:// endpoint for an https explorer client', function () {
        expect(sdk.isDowngrade('explorer', { baseUrl: 'https://a' }, 'wss://b')).to.equal(true);
    });
});
