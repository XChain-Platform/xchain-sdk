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

    describe('getContractManifest()', function () {
        // The manifest read normalizes contract IDENTITY (meta_*) alongside the
        // permissions manifest, so every case carries the four identity keys; a
        // contract deployed before CONTRACT_META_REQUIRED has none and reads null.
        const NO_META = { name: null, description: null, version: null, meta: null };

        it('normalizes a snake_case manifest (permissions JSON string + max_take_bps)', async function () {
            nock(BASE).get('/BTC/api/contract/42').reply(200, { action_index: 42, permissions: '["SEND","MINT"]', max_take_bps: 300 });
            let m = await client.getContractManifest(42);
            expect(m).to.deep.equal({ permissions: ['SEND', 'MINT'], maxTakeBps: 300, ...NO_META });
        });
        it('passes through an already-parsed permissions array', async function () {
            nock(BASE).get('/BTC/api/contract/7').reply(200, { action_index: 7, permissions: ['SEND'], max_take_bps: null });
            let m = await client.getContractManifest(7);
            expect(m).to.deep.equal({ permissions: ['SEND'], maxTakeBps: null, ...NO_META });
        });
        it('returns nulls when the contract declares no manifest', async function () {
            nock(BASE).get('/BTC/api/contract/9').reply(200, { action_index: 9 });
            let m = await client.getContractManifest(9);
            expect(m).to.deep.equal({ permissions: null, maxTakeBps: null, ...NO_META });
        });
        it('carries the contract identity the explorer reports', async function () {
            nock(BASE).get('/BTC/api/contract/11').reply(200, {
                action_index: 11, permissions: null, max_take_bps: null,
                meta_name: 'Escrow', meta_description: 'Two-party escrow with an arbiter', meta_version: '1.0.0',
                meta: { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' }
            });
            let m = await client.getContractManifest(11);
            expect(m.name).to.equal('Escrow');
            expect(m.description).to.equal('Two-party escrow with an arbiter');
            expect(m.version).to.equal('1.0.0');
            expect(m.meta).to.deep.equal({ name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '1.0.0' });
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('pagination', function () {
        it('passes page, limit, sortorder as query params', async function () {
            nock(BASE)
                .get('/BTC/api/balances/addr1')
                .query({ page: '2', limit: '50', sortorder: 'DESC' })
                .reply(200, { total: 100, data: [] });
            let result = await client.getBalances('addr1', { page: 2, limit: 50, sortorder: 'DESC' });
            expect(result.total).to.equal(100);
        });

        it('omits undefined params', async function () {
            nock(BASE)
                .get('/BTC/api/balances/addr1')
                .query({ page: '1' })
                .reply(200, { data: [] });
            let result = await client.getBalances('addr1', { page: 1 });
            expect(result).to.have.property('data');
        });
    });
});
