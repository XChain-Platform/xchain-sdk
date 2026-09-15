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

    describe('market methods', function () {
        it('getMarkets with tick returns result', async function () {
            nock(BASE).get('/BTC/api/markets/TOKEN').reply(200, { data: [] });
            const r = await client.getMarkets('TOKEN');
            expect(r).to.have.property('data');
        });

        it('getMarkets without tick returns result', async function () {
            nock(BASE).get('/BTC/api/markets').reply(200, { data: [] });
            const r = await client.getMarkets();
            expect(r).to.have.property('data');
        });

        it('getMarketOrders with address returns result', async function () {
            nock(BASE).get('/BTC/api/market/A/B/orders/addr1').reply(200, { data: [] });
            const r = await client.getMarketOrders('A', 'B', 'addr1');
            expect(r).to.have.property('data');
        });

        it('getMarketOrders without address returns result', async function () {
            nock(BASE).get('/BTC/api/market/A/B/orders').reply(200, { data: [] });
            const r = await client.getMarketOrders('A', 'B', null);
            expect(r).to.have.property('data');
        });

        it('getOrderbook returns result', async function () {
            nock(BASE).get('/BTC/api/market/A/B/orderbook').reply(200, { asks: [], bids: [] });
            const r = await client.getOrderbook('A', 'B');
            expect(r).to.have.property('asks');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('staking methods', function () {
        it('getContractUnstakes without query returns result', async function () {
            nock(BASE).get('/BTC/api/contract_unstakes').reply(200, { total: 0, data: [] });
            const r = await client.getContractUnstakes(null, 'address');
            expect(r.total).to.equal(0);
        });

        it('getSlashEvents without query returns result', async function () {
            nock(BASE).get('/BTC/api/slash_events').reply(200, { total: 0, data: [] });
            const r = await client.getSlashEvents(null, 'contract');
            expect(r.total).to.equal(0);
        });

        it('getAttestations slash_events with query (type cover)', async function () {
            nock(BASE).get('/BTC/api/slash_events/42/contract').reply(200, { total: 1, data: [] });
            const r = await client.getSlashEvents(42, 'contract');
            expect(r.total).to.equal(1);
        });
    });
});
