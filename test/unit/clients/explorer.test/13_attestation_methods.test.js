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

    describe('attestation methods', function () {
        it('getAttestations with query returns result', async function () {
            nock(BASE).get('/BTC/api/attestations/addr1/address').reply(200, { total: 1, data: [] });
            const r = await client.getAttestations('addr1', 'address');
            expect(r.total).to.equal(1);
        });

        it('getAttestations without query returns result', async function () {
            nock(BASE).get('/BTC/api/attestations').reply(200, { total: 0, data: [] });
            const r = await client.getAttestations(null, 'address');
            expect(r.total).to.equal(0);
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('VOTE governance methods', function () {
        it('getPolls with query hits /{COIN}/api/polls/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/polls/GOV/tick').reply(200, { total: 1, data: [{ action_index: 5, poll_status: 'open' }] });
            const r = await client.getPolls('GOV', 'tick');
            expect(r.data[0].poll_status).to.equal('open');
        });

        it('getPolls without query hits /{COIN}/api/polls', async function () {
            nock(BASE).get('/BTC/api/polls').reply(200, { total: 0, data: [] });
            const r = await client.getPolls();
            expect(r).to.have.property('data');
        });

        it('getPoll hits /{COIN}/api/poll/{pollIndex} and returns the poll object', async function () {
            nock(BASE).get('/BTC/api/poll/5').reply(200, { action_index: 5, question: 'Ship it?', options: ['yes', 'no'], poll_status: 'open' });
            const r = await client.getPoll(5);
            expect(r.action_index).to.equal(5);
            expect(r.options).to.deep.equal(['yes', 'no']);
        });

        it('getPollResults hits /{COIN}/api/poll/{pollIndex}/results', async function () {
            nock(BASE).get('/BTC/api/poll/5/results').reply(200, { total: 2, data: [{ option_index: 0, total_weight: '100', voter_count: 3 }] });
            const r = await client.getPollResults(5);
            expect(r.data[0].total_weight).to.equal('100');
        });

        it('getVotes with query hits /{COIN}/api/votes/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/votes/5/poll').reply(200, { total: 1, data: [{ poll_index: 5, choice: 0, share: '1' }] });
            const r = await client.getVotes('5', 'poll');
            expect(r.data[0].choice).to.equal(0);
        });

        it('getVotes without query hits /{COIN}/api/votes', async function () {
            nock(BASE).get('/BTC/api/votes').reply(200, { total: 0, data: [] });
            const r = await client.getVotes();
            expect(r).to.have.property('data');
        });
    });
});
