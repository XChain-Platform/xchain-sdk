// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const nock = require('nock');
const sinon = require('sinon');
const ExplorerClient = require('../../../../src/clients/explorer.js');

const BASE = 'http://explorer.test:8080';
let client;

function resetClient() {
    client = new ExplorerClient({
        network: 'bitcoin-mainnet',
        explorerUrl: 'explorer.test',
        explorerPort: 8080,
        retry: false
    });
}

function cleanNock() {
    nock.cleanAll();
}

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('search error handling', function () {
        it('wraps HTTP error in search path', async function () {
            nock(BASE).get('/BTC/explorer/search/foo/token').reply(404, { error: 'not found' });
            try {
                await client.search('foo', 'token');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_HTTP_404');
            }
        });

        it('wraps network error in search path', async function () {
            nock(BASE).get('/BTC/explorer/search/foo/token').replyWithError('connection reset');
            try {
                await client.search('foo', 'token');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_NETWORK');
            }
        });

        it('fires onRequest/onResponse hooks in search', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onRequest, onResponse }
            });
            nock(BASE).get('/BTC/explorer/search/foo/token').reply(200, { data: [] });
            await hooked.search('foo', 'token');
            expect(onRequest.calledOnce).to.be.true;
            expect(onResponse.calledOnce).to.be.true;
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('search error handling', function () {

        it('fires onError hook in search on failure', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onError }
            });
            nock(BASE).get('/BTC/explorer/search/foo/token').replyWithError('down');
            try { await hooked.search('foo', 'token'); } catch(e) {}
            expect(onError.calledOnce).to.be.true;
        });

        it('outer catch wraps retryable error that exhausted retries', async function () {
            // Use sinon to inject an ECONNRESET error so isRetryable=true but
            // retry:false means maxRetries=0, so it exhausts immediately and
            // reaches the outer catch -> _handleError
            const noRetry = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false
            });
            const err = new Error('connection reset');
            err.code = 'ECONNRESET';
            sinon.stub(noRetry.client, 'get').rejects(err);
            try {
                await noRetry.search('foo', 'token');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_NETWORK');
            }
        });

    });
});
