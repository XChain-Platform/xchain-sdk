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

    describe('balance & address methods', function () {
        it('getAddress returns result', async function () {
            nock(BASE).get('/BTC/api/address/addr1').reply(200, { address: 'addr1', total_received: '100' });
            const r = await client.getAddress('addr1');
            expect(r.address).to.equal('addr1');
        });

        it('getPublicKey returns result', async function () {
            nock(BASE).get('/BTC/api/pubkey/addr1').reply(200, { pubkey: '02abc' });
            const r = await client.getPublicKey('addr1');
            expect(r.pubkey).to.equal('02abc');
        });

        it('getHolders returns result', async function () {
            nock(BASE).get('/BTC/api/holders/TOKEN').reply(200, { total: 5, data: [] });
            const r = await client.getHolders('TOKEN');
            expect(r.total).to.equal(5);
        });

        it('getCredits returns result', async function () {
            nock(BASE).get('/BTC/api/credits/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getCredits('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getDebits returns result', async function () {
            nock(BASE).get('/BTC/api/debits/addr1/address').reply(200, { total: 2, data: [] });
            const r = await client.getDebits('addr1', 'address');
            expect(r.total).to.equal(2);
        });

        it('getEscrows returns result', async function () {
            nock(BASE).get('/BTC/api/escrows/addr1/address').reply(200, { data: [] });
            const r = await client.getEscrows('addr1', 'address');
            expect(r).to.have.property('data');
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('token methods', function () {
        it('getTokens returns result', async function () {
            nock(BASE).get('/BTC/api/tokens/addr1/address').reply(200, { total: 3, data: [] });
            const r = await client.getTokens('addr1', 'address');
            expect(r.total).to.equal(3);
        });

        it('getIssues returns result', async function () {
            nock(BASE).get('/BTC/api/issues/TOKEN/token').reply(200, { total: 1, data: [] });
            const r = await client.getIssues('TOKEN', 'token');
            expect(r.total).to.equal(1);
        });
    });
});
