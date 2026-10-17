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
const ExplorerClient = require('../../../../../src/clients/explorer.js');

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

    describe('fee methods', function () {
        it('getFeeQuote returns result', async function () {
            nock(BASE)
                .get('/BTC/api/feequote')
                .query({ action: 'SEND', params: '0|TOKEN|100|addr1', source: 'addr1' })
                .reply(200, { supported: true, valid: true, requiredFeeSats: 1000 });
            const r = await client.getFeeQuote({ action: 'SEND', params: ['0', 'TOKEN', '100', 'addr1'], source: 'addr1' });
            expect(r.supported).to.be.true;
        });

        it('getFeeQuote with string params', async function () {
            nock(BASE)
                .get('/BTC/api/feequote')
                .query({ action: 'SEND', params: '0|TOKEN|100' })
                .reply(200, { supported: true });
            const r = await client.getFeeQuote({ action: 'SEND', params: '0|TOKEN|100' });
            expect(r.supported).to.be.true;
        });

        it('getFeeQuote with feeOutputSats', async function () {
            nock(BASE)
                .get('/BTC/api/feequote')
                .query({ action: 'SEND', feeOutputSats: '5000' })
                .reply(200, { supported: true });
            const r = await client.getFeeQuote({ action: 'SEND', feeOutputSats: 5000 });
            expect(r.supported).to.be.true;
        });

        it('getFeeSchedule returns result', async function () {
            nock(BASE).get('/BTC/api/feeschedule').reply(200, { actions: [] });
            const r = await client.getFeeSchedule();
            expect(r).to.have.property('actions');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('pre-flight transport', function () {
        it('getPreflight keeps a small action on the GET route', async function () {
            const get = nock(BASE)
                .get('/BTC/api/preflight')
                .query({ action: 'SEND', params: '0|TOKEN|100', feeMode: 'native' })
                .reply(200, { supported: true, valid: true });
            const r = await client.getPreflight({ action: 'SEND', params: ['0', 'TOKEN', '100'], feeMode: 'native' });
            expect(r.valid).to.be.true;
            expect(get.isDone()).to.be.true;
        });

        it('getPreflight posts an action too long for a GET line to the same route as a JSON body', async function () {
            const params = 'x'.repeat(17500);
            let sent = null;
            const post = nock(BASE)
                .post('/BTC/api/preflight', (body) => { sent = body; return true; })
                .reply(200, { supported: true, valid: false });
            const r = await client.getPreflight({ action: 'BATCH', params, source: 'addr1' }, { noRetry: true });
            expect(post.isDone()).to.be.true;
            expect(sent).to.deep.equal({ action: 'BATCH', params, source: 'addr1' });
            expect(r.valid).to.equal(false);
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('price methods', function () {
        it('getPrices with query returns result', async function () {
            nock(BASE).get('/BTC/api/prices/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getPrices('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getPrices without query returns result', async function () {
            nock(BASE).get('/BTC/api/prices').reply(200, { total: 0, data: [] });
            const r = await client.getPrices(null, 'address');
            expect(r.total).to.equal(0);
        });

        it('getPriceSnapshots with query returns result', async function () {
            nock(BASE).get('/BTC/api/price_snapshots/BTC-USD/pair').reply(200, { data: [] });
            const r = await client.getPriceSnapshots('BTC-USD', 'pair');
            expect(r).to.have.property('data');
        });

        it('getPriceSnapshots without query returns result', async function () {
            nock(BASE).get('/BTC/api/price_snapshots').reply(200, { data: [] });
            const r = await client.getPriceSnapshots(null, 'pair');
            expect(r).to.have.property('data');
        });
    });
});
