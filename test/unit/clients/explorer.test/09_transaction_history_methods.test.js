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

    describe('transaction & history methods', function () {
        it('getAction returns result', async function () {
            nock(BASE).get('/BTC/api/action/42').reply(200, { action_index: 42 });
            const r = await client.getAction(42);
            expect(r.action_index).to.equal(42);
        });

        it('getActions returns result', async function () {
            nock(BASE).get('/BTC/api/actions').reply(200, { total: 10, data: [] });
            const r = await client.getActions();
            expect(r.total).to.equal(10);
        });

        it('getBlock returns result', async function () {
            nock(BASE).get('/BTC/api/block/100').reply(200, { block_index: 100 });
            const r = await client.getBlock(100);
            expect(r.block_index).to.equal(100);
        });

        it('getHistory returns result', async function () {
            nock(BASE).get('/BTC/api/history/addr1/address').reply(200, { total: 5, data: [] });
            const r = await client.getHistory('addr1', 'address');
            expect(r.total).to.equal(5);
        });
    });
});
