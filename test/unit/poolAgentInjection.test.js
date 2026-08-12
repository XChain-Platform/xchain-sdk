// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

//  / : `pool.httpAgent` / `pool.httpsAgent` are the SDK's
// only injection point for a caller that opens sockets differently, and
// the wallet's Tor toggle is built entirely on top of it: the desktop
// shell hands these three clients SOCKS5 agents and the user is told
// their traffic is anonymised.
//
// It had NO test. That is the wrong thing to leave uncovered, because
// every way it can break is silent. An agent dropped on one client, or
// landed in the slot for the scheme the base URL is not, leaves that
// lane connecting DIRECTLY while the toggle still reads "on" and every
// request still succeeds - which is the exact misrepresentation 
// exists to close, reintroduced one client at a time.
//
// So each assertion below is about WHICH socket-opener ends up in force,
// and the http/https pairs are asserted separately because axios reads
// only the one matching the base URL's scheme.

const { expect } = require('chai');
const http  = require('http');
const https = require('https');
const sinon = require('sinon');
const axios = require('axios');

const ExplorerClient = require('../../src/explorer.js');
const EncoderClient  = require('../../src/encoder.js');
const HubConnector   = require('../../src/hub.js');

// Recognisable stand-ins for a SOCKS agent. Real ones are http/https
// Agent subclasses that dial through a proxy; all that matters here is
// identity, so a broken wiring shows up as "not the object I passed".
function marker(kind) {
    const agent = kind === 'https' ? new https.Agent() : new http.Agent();
    agent.__socksMarker = kind;
    return agent;
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

        it('survives a hub-discovery repoint, which rebuilds the client', function () {
            // setBase() calls _buildClient() again. An injected agent that
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

    // The hub is the lane that would have been missed. It has no pooled
    // client of its own - every call is a bare `axios.post` - so the agents
    // have to be attached per request, and the endpoint list can mix
    // schemes, so the choice has to be made per URL rather than once.
    describe('HubConnector', function () {

        afterEach(function () {
            sinon.restore();
        });

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
