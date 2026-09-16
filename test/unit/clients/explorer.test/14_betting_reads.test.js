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

    // BET reads. Without the unfiltered branches, a caller asking for EVERY
    // market or EVERY bet interpolates the literals and requests
    // `/bet_feeds/null/null`, which the explorer 404s. The wallet's "All
    // markets" filter did exactly that on every click, and it survived a
    // green suite on both sides because the SDK suite mocks this client and
    // the wallet suite mocks the SDK. Only a live browser run caught it, so
    // the URLs are pinned here where a unit test can.
    describe('betting reads', function () {
        it('getBetFeeds with query hits /{COIN}/api/bet_feeds/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/bet_feeds/open/status').reply(200, { total: 1, data: [{ action_index: 7 }] });
            const r = await client.getBetFeeds('open', 'status');
            expect(r.data[0].action_index).to.equal(7);
        });

        it('getBetFeeds WITHOUT a query hits /{COIN}/api/bet_feeds, never /null/null', async function () {
            nock(BASE).get('/BTC/api/bet_feeds').reply(200, { total: 0, data: [] });
            const r = await client.getBetFeeds();
            expect(r).to.have.property('data');
        });

        it('getBetFeeds treats an explicit null query as unfiltered', async function () {
            // The wallet's flow layer normalizes a missing filter to null before it
            // reaches here (`sdk.getBetFeeds(query || null, type || null, opts)`),
            // so null is the shape that actually arrives in production.
            nock(BASE).get('/BTC/api/bet_feeds').reply(200, { total: 0, data: [] });
            const r = await client.getBetFeeds(null, null, {});
            expect(r).to.have.property('data');
        });

        it('getBets with query hits /{COIN}/api/bets/{query}/{type}', async function () {
            nock(BASE).get('/BTC/api/bets/9/feed').reply(200, { total: 1, data: [{ outcome: 0 }] });
            const r = await client.getBets('9', 'feed');
            expect(r.data[0].outcome).to.equal(0);
        });

        it('getBets WITHOUT a query hits /{COIN}/api/bets, never /null/null', async function () {
            nock(BASE).get('/BTC/api/bets').reply(200, { total: 0, data: [] });
            const r = await client.getBets(null, null);
            expect(r).to.have.property('data');
        });

        it('getOracleStats hits /{COIN}/api/oracle/{address}', async function () {
            nock(BASE).get('/BTC/api/oracle/mjwvuk').reply(200, { address: 'mjwvuk', total_feeds: 1, fees_earned: [] });
            const r = await client.getOracleStats('mjwvuk');
            expect(r.address).to.equal('mjwvuk');
        });
    });
});
