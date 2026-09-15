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

    describe('timeout errors', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('wraps ECONNABORTED as EXPLORER_TIMEOUT', async function () {
            const noRetry = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false
            });
            const err = new Error('timeout exceeded');
            err.code = 'ECONNABORTED';
            sinon.stub(noRetry.client, 'get').rejects(err);
            try {
                await noRetry.getStatus();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.name).to.equal('SDKExplorerError');
                expect(e.code).to.equal('EXPLORER_TIMEOUT');
            }
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('HTTPS base URL', function () {
        it('builds client with https agent when url starts with https', function () {
            const c = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'https://explorer.xchain.io'
            });
            expect(c.client.defaults.baseURL).to.equal('https://explorer.xchain.io');
        });
    });
});
