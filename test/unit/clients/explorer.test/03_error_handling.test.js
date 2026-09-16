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

    describe('error handling', function () {
        it('wraps HTTP 404 as SDKExplorerError', async function () {
            nock(BASE).get('/BTC/api/token/NOEXIST').reply(404, { error: 'not found' });
            try {
                await client.getToken('NOEXIST');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_HTTP_404');
                expect(e.details.status).to.equal(404);
            }
        });

        it('wraps HTTP 503 as SDKExplorerError', async function () {
            nock(BASE).get('/BTC/api/status').reply(503);
            try {
                await client.getStatus();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.code).to.equal('EXPLORER_HTTP_503');
            }
        });

        it('wraps network errors', async function () {
            nock(BASE).get('/BTC/api/status').replyWithError('connection reset');
            try {
                await client.getStatus();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_NETWORK');
            }
        });
    });
});
