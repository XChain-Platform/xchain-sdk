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
const ExplorerClient = require('../../../../../src/clients/explorer.js');

const BASE = 'http://explorer.test:8080';
let client;

describe('ExplorerClient', function () {
    beforeEach(function () {
        client = new ExplorerClient({
            network: 'bitcoin-mainnet', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false,
        });
    });
    afterEach(function () { nock.cleanAll(); });

    describe('getExecutions query presence', function () {
        it('getExecutions treats action index 0 as a real contract, not as an absent filter', async function () {
            const filtered = nock(BASE).get('/BTC/api/executions/0/contract').reply(200, { total: 1, data: [] });
            expect((await client.getExecutions(0)).total).to.equal(1);
            expect(filtered.isDone()).to.equal(true);
            nock(BASE).get('/BTC/api/executions/0/contract').reply(200, { total: 2, data: [] });
            expect((await client.getExecutions('0')).total).to.equal(2);
        });

        it('getExecutions still lists every contract when the query is absent', async function () {
            nock(BASE).get('/BTC/api/executions').times(3).reply(200, { total: 0, data: [] });
            await client.getExecutions(undefined);
            await client.getExecutions(null);
            await client.getExecutions('');
            expect(nock.isDone()).to.equal(true);
        });
    });
});
