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

    describe('utility methods', function () {
        it('getStatus returns result', async function () {
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            const r = await client.getStatus();
            expect(r.status).to.equal('ok');
        });

        it('getMempool returns result', async function () {
            nock(BASE).get('/BTC/api/mempool/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getMempool('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getNetwork returns result', async function () {
            nock(BASE).get('/BTC/api/network').reply(200, { height: 100 });
            const r = await client.getNetwork();
            expect(r.height).to.equal(100);
        });
    });
});
