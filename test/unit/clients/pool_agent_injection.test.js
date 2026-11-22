// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// `pool.httpAgent` / `pool.httpsAgent` are the SDK's only injection point
// for a caller that opens sockets differently, and the wallet's Tor toggle
// is built entirely on top of it: the desktop shell hands these three
// clients SOCKS5 agents and the user is told their traffic is anonymised.
//
// It had NO test. That is the wrong thing to leave uncovered, because
// every way it can break is silent. An agent dropped on one client, or
// landed in the slot for the scheme the base URL is not, leaves that
// lane connecting DIRECTLY while the toggle still reads "on" and every
// request still succeeds - which is the exact misrepresentation this
// suite exists to close, reintroduced one client at a time.
//
// So each assertion below is about WHICH socket-opener ends up in force,
// and the http/https pairs are asserted separately because axios reads
// only the one matching the base URL's scheme.

const { expect } = require('chai');
const http  = require('http');
const https = require('https');
const sinon = require('sinon');
const axios = require('axios');
const nock  = require('nock');

const ExplorerClient = require('../../../src/clients/explorer.js');
const EncoderClient  = require('../../../src/clients/encoder.js');
const HubConnector   = require('../../../src/clients/hub.js');
const WebSocketClient = require('../../../src/clients/websocket.js');
const XChainSDK      = require('../../../src/XChainSDK.js');

// Recognisable stand-ins for a SOCKS agent. Real ones are http/https
// Agent subclasses that dial through a proxy; all that matters here is
// identity, so a broken wiring shows up as "not the object I passed".
function marker(kind) {
    const agent = kind === 'https' ? new https.Agent() : new http.Agent();
    agent.__socksMarker = kind;
    return agent;
}

function restoreSinon() {
    sinon.restore();
}

describe('injected connection agents (pool.httpAgent / pool.httpsAgent)', function () {

    describe('ExplorerClient', function () {

        it('uses the injected http agent for an http base', function () {
            const httpAgent = marker('http');
            const client = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                pool: { httpAgent, httpsAgent: marker('https') }
            });
            expect(client.client.defaults.httpAgent).to.equal(httpAgent);
            // The https slot must stay empty on an http base: axios would
            // ignore it, and a future reader must not think it is in force.
            expect(client.client.defaults.httpsAgent).to.equal(undefined);
        });

        it('uses the injected https agent for an https base', function () {
            const httpsAgent = marker('https');
            const client = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'https://explorer.test',
                pool: { httpAgent: marker('http'), httpsAgent }
            });
            expect(client.client.defaults.httpsAgent).to.equal(httpsAgent);
            expect(client.client.defaults.httpAgent).to.equal(undefined);
        });
    });
});

describe('injected connection agents (pool.httpAgent / pool.httpsAgent)', function () {

    describe('ExplorerClient', function () {

        it('survives a hub-discovery repoint, which rebuilds the client', function () {
            // setBase() calls buildClient() again. An injected agent that
            // was only applied at construction would be silently dropped the
            // moment the SDK overlaid hub-published endpoints - traffic goes
            // direct from then on, with nothing to see.
            const httpAgent = marker('http');
            const client = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                pool: { httpAgent }
            });
            client.setBase('other.test', 9090);
            expect(client.client.defaults.baseURL).to.equal('http://other.test:9090');
            expect(client.client.defaults.httpAgent).to.equal(httpAgent);
        });

        it('falls back to a pooled keep-alive agent when nothing is injected', function () {
            const client = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080
            });
            expect(client.client.defaults.httpAgent).to.be.an.instanceof(http.Agent);
            expect(client.client.defaults.httpAgent.__socksMarker).to.equal(undefined);
            expect(client.client.defaults.httpAgent.keepAlive).to.equal(true);
        });

        it('does not let axios layer its own env proxy over the injected agent', function () {
            // With `proxy` unset, axios honours HTTP(S)_PROXY from the
            // environment and would wrap a tunnel around the SOCKS agent.
            const client = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                pool: { httpAgent: marker('http') }
            });
            expect(client.client.defaults.proxy).to.equal(false);
        });
    });
});

describe('injected connection agents (pool.httpAgent / pool.httpsAgent)', function () {

    describe('EncoderClient', function () {

        it('uses the injected http agent for an http base', function () {
            const httpAgent = marker('http');
            const client = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3003,
                pool: { httpAgent, httpsAgent: marker('https') }
            });
            expect(client.client.defaults.httpAgent).to.equal(httpAgent);
            expect(client.client.defaults.httpsAgent).to.equal(undefined);
        });

        it('uses the injected https agent for an https base', function () {
            const httpsAgent = marker('https');
            const client = new EncoderClient({
                encoderUrl: 'https://encoder.test',
                pool: { httpsAgent }
            });
            expect(client.client.defaults.httpsAgent).to.equal(httpsAgent);
            expect(client.client.defaults.httpAgent).to.equal(undefined);
        });

        it('survives a hub-discovery repoint', function () {
            const httpAgent = marker('http');
            const client = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3003,
                pool: { httpAgent }
            });
            client.setBase('other.test', 3103);
            expect(client.client.defaults.httpAgent).to.equal(httpAgent);
        });

        it('falls back to a pooled keep-alive agent when nothing is injected', function () {
            const client = new EncoderClient({ encoderUrl: 'encoder.test', encoderPort: 3003 });
            expect(client.client.defaults.httpAgent).to.be.an.instanceof(http.Agent);
            expect(client.client.defaults.httpAgent.__socksMarker).to.equal(undefined);
        });
    });
});

describe('injected connection agents (pool.httpAgent / pool.httpsAgent)', function () {

    // The hub is the lane that would have been missed. It has no pooled
    // client of its own - every call is a bare `axios.post` - so the agents
    // have to be attached per request, and the endpoint list can mix
    // schemes, so the choice has to be made per URL rather than once.
    describe('HubConnector', function () {
        afterEach(restoreSinon);

        it('attaches the injected http agent to its bare axios.post', async function () {
            const httpAgent = marker('http');
            const post = sinon.stub(axios, 'post').resolves({ data: { result: 'pong' } });
            const hub = new HubConnector({
                hubUrl: 'hub.test',
                hubPort: 10000,
                pool: { httpAgent, httpsAgent: marker('https') }
            });

            expect(await hub.ping()).to.equal(true);
            const opts = post.firstCall.args[2];
            expect(opts.httpAgent).to.equal(httpAgent);
            expect(opts.httpsAgent).to.equal(undefined);
            expect(opts.proxy).to.equal(false);
        });

        it('chooses per endpoint when the hub list mixes schemes', async function () {
            // A single https endpoint in an otherwise http list would
            // otherwise take the http agent and connect direct.
            const httpAgent  = marker('http');
            const httpsAgent = marker('https');
            const post = sinon.stub(axios, 'post');
            post.onFirstCall().rejects(new Error('down'));
            post.onSecondCall().resolves({ data: { result: 'pong' } });

            const hub = new HubConnector({
                hubValidators: ['http://hub-a.test:10000', 'https://hub-b.test'],
                pool: { httpAgent, httpsAgent }
            });

            expect(await hub.ping()).to.equal(true);
            expect(post.firstCall.args[2].httpAgent).to.equal(httpAgent);
            expect(post.firstCall.args[2].httpsAgent).to.equal(undefined);
            expect(post.secondCall.args[2].httpsAgent).to.equal(httpsAgent);
            expect(post.secondCall.args[2].httpAgent).to.equal(undefined);
        });

        it('still disables axios env-proxy handling when no agents are injected', async function () {
            const post = sinon.stub(axios, 'post').resolves({ data: { result: 'pong' } });
            const hub = new HubConnector({ hubUrl: 'hub.test', hubPort: 10000 });

            expect(await hub.ping()).to.equal(true);
            const opts = post.firstCall.args[2];
            expect(opts.proxy).to.equal(false);
            expect(opts.httpAgent).to.equal(undefined);
            expect(opts.httpsAgent).to.equal(undefined);
        });
    });
});


// The address-subscription socket is the lane a Tor toggle must not miss: it
// carries the user's address set, so a direct dial leaks both the IP and
// what is being watched. Node's http.request hands the request to
// agent.addRequest synchronously, so a spy shows which agent a dial used
// without any server. Port 1 on loopback refuses at once.
const DEAD_HTTP = 'http://127.0.0.1:1';

function spyAgents() {
    const httpAgent  = marker('http');
    const httpsAgent = marker('https');
    return {
        httpAgent, httpsAgent,
        httpSpy:  sinon.spy(httpAgent, 'addRequest'),
        httpsSpy: sinon.spy(httpsAgent, 'addRequest')
    };
}

async function dial(client) {
    try { await client.connect(); } catch (e) { /* refused: only the agent choice matters */ }
    client.disconnect();
}

function wsClient(url, pool) {
    return new WebSocketClient({ network: 'bitcoin-regtest', websocketUrl: url, pool });
}

// nock replaces http.request while active and then never calls the agent, so
// a spy on the agent would read zero whichever agent the dial was given. The
// real http stack is put back around the dial cases and nock restored after.
function realHttpStack() {
    let nockWasActive;
    before(function () { nockWasActive = nock.isActive(); if (nockWasActive) nock.restore(); });
    after(function () { if (nockWasActive) nock.activate(); });
    afterEach(restoreSinon);
}

describe('injected connection agents (pool.httpAgent / pool.httpsAgent)', function () {

    describe('WebSocketClient scheme choice', function () {
        realHttpStack();

        it('dials a ws:// URL through the injected http agent only', async function () {
            const a = spyAgents();
            await dial(wsClient('ws://127.0.0.1:1', { httpAgent: a.httpAgent, httpsAgent: a.httpsAgent }));
            expect(a.httpSpy.callCount).to.equal(1);
            expect(a.httpsSpy.callCount).to.equal(0);
        });

        it('dials a wss:// URL through the injected https agent only', async function () {
            const a = spyAgents();
            await dial(wsClient('wss://127.0.0.1:1', { httpAgent: a.httpAgent, httpsAgent: a.httpsAgent }));
            expect(a.httpsSpy.callCount).to.equal(1);
            expect(a.httpSpy.callCount).to.equal(0);
        });

        it('rewrites an https:// base to wss:// and uses the https agent', async function () {
            const a = spyAgents();
            await dial(wsClient('https://127.0.0.1:1', { httpAgent: a.httpAgent, httpsAgent: a.httpsAgent }));
            expect(a.httpsSpy.callCount).to.equal(1);
            expect(a.httpSpy.callCount).to.equal(0);
        });
    });

    describe('WebSocketClient fallbacks', function () {
        realHttpStack();

        it('never falls back to the other scheme agent when its own slot is empty', async function () {
            const a = spyAgents();
            await dial(wsClient('wss://127.0.0.1:1', { httpAgent: a.httpAgent }));
            expect(a.httpSpy.callCount).to.equal(0);
        });

        it('keeps using the injected agent after a repoint to another scheme', async function () {
            const a = spyAgents();
            const client = wsClient('ws://127.0.0.1:1', { httpAgent: a.httpAgent, httpsAgent: a.httpsAgent });
            await dial(client);
            client.setBase('wss://127.0.0.1:2');
            await dial(client);
            expect(a.httpSpy.callCount).to.equal(1);
            expect(a.httpsSpy.callCount).to.equal(1);
        });

        it('still dials when no pool is injected', async function () {
            const client = wsClient('ws://127.0.0.1:1');
            let err;
            try { await client.connect(); } catch (e) { err = e; }
            client.disconnect();
            expect(err.code).to.be.oneOf(['WS_CONNECTION_FAILED', 'WS_CONNECTION_CLOSED']);
        });
    });
});

describe('injected connection agents (pool.httpAgent / pool.httpsAgent)', function () {

    describe('XChainSDK websocket lane', function () {
        realHttpStack();

        it('builds sdk.ws with the injected pool and dials through its agent', async function () {
            const a = spyAgents();
            const sdk = new XChainSDK({
                network: 'bitcoin-regtest', explorerUrl: DEAD_HTTP, encoderUrl: DEAD_HTTP, retry: false,
                pool: { httpAgent: a.httpAgent, httpsAgent: a.httpsAgent }
            });
            await dial(sdk.ws);
            expect(a.httpSpy.callCount).to.equal(1);
            expect(a.httpsSpy.callCount).to.equal(0);
        });

        it('builds the websocket client from hub endpoints with the injected pool', async function () {
            const a = spyAgents();
            const sdk = new XChainSDK({ network: 'bitcoin-regtest', explorerUrl: DEAD_HTTP, retry: false });
            sdk.ws = null;
            sdk.hub = { extractServiceEndpoints: () => ({ explorerUrl: DEAD_HTTP }) };
            sdk.options = { network: 'bitcoin-regtest', retry: false, pool: { httpAgent: a.httpAgent, httpsAgent: a.httpsAgent } };
            sdk.applyEndpoints();
            await dial(sdk.ws);
            expect(a.httpSpy.callCount).to.equal(1);
            expect(a.httpsSpy.callCount).to.equal(0);
        });
    });
});
