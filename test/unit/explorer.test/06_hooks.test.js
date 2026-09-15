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
const ExplorerClient = require('../../../src/clients/explorer.js');

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

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onRequest and onResponse hooks on success', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onRequest, onResponse }
            });
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            await hooked.getStatus();
            expect(onRequest.calledOnce).to.be.true;
            expect(onRequest.firstCall.args[0].service).to.equal('explorer');
            expect(onResponse.calledOnce).to.be.true;
        });

        it('fires onError hook on failure', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onError }
            });
            nock(BASE).get('/BTC/api/status').replyWithError('network down');
            try { await hooked.getStatus(); } catch (e) { /* expected */ }
            expect(onError.calledOnce).to.be.true;
        });

        it('fires onRetry hook on retryable failure', async function () {
            const onRetry = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: { maxRetries: 1, baseDelay: 0, maxDelay: 0, backoffFactor: 1 },
                hooks: { onRetry }
            });
            nock(BASE).get('/BTC/api/status').reply(503, 'unavailable');
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            await hooked.getStatus();
            expect(onRetry.calledOnce).to.be.true;
        });
    });
});
