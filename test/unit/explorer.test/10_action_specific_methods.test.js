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

    describe('action-specific methods', function () {
        const pairs = [
            ['getAddresses', 'addresses'],
            ['getAirdrops', 'airdrops'],
            ['getBatches', 'batches'],
            ['getBroadcasts', 'broadcasts'],
            ['getCallbacks', 'callbacks'],
            ['getDestroys', 'destroys'],
            ['getCoinpays', 'coinpays'],
            ['getCoinpayExpires', 'coinpay_expires'],
            ['getCoinpayObligations', 'coinpay_obligations'],
            ['getDispensers', 'dispensers'],
            ['getDispenses', 'dispenses'],
            ['getDispenserCancels', 'dispenser_cancels'],
            ['getDispenserCloses', 'dispenser_closes'],
            ['getDispenserExpires', 'dispenser_expires'],
            ['getDispenserEdits', 'dispenser_edits'],
            ['getDividends', 'dividends'],
            ['getFees', 'fees'],
            ['getFiles', 'files'],
            ['getLinks', 'links'],
            ['getLists', 'lists'],
            ['getMessages', 'messages'],
            ['getMints', 'mints'],
            ['getOrders', 'orders'],
            ['getOrderCancels', 'order_cancels'],
            ['getOrderEdits', 'order_edits'],
            ['getOrderExpires', 'order_expires'],
            ['getSleeps', 'sleeps'],
            ['getSwaps', 'swaps'],
            ['getSwapCancels', 'swap_cancels'],
            ['getSwapEdits', 'swap_edits'],
            ['getSwapExpires', 'swap_expires'],
            ['getSweeps', 'sweeps']
        ];

        for (const [method, path] of pairs) {
            it(method + ' returns result', async function () {
                nock(BASE).get('/BTC/api/' + path + '/addr1/address').reply(200, { total: 1, data: [] });
                const r = await client[method]('addr1', 'address');
                expect(r.total).to.equal(1);
            });
        }

        it('getOrderMatches with query returns result', async function () {
            nock(BASE).get('/BTC/api/order_matches/100/block').reply(200, { total: 1, data: [] });
            const r = await client.getOrderMatches(100, 'block');
            expect(r.total).to.equal(1);
        });
    });
});

describe('ExplorerClient', function () {
    beforeEach(resetClient);
    afterEach(cleanNock);

    describe('action-specific methods', function () {

        it('getOrderMatches without query returns result', async function () {
            nock(BASE).get('/BTC/api/order_matches').reply(200, { total: 0, data: [] });
            const r = await client.getOrderMatches(null);
            expect(r.total).to.equal(0);
        });

        it('getSwapMatches with query returns result', async function () {
            nock(BASE).get('/BTC/api/swap_matches/100/block').reply(200, { total: 1, data: [] });
            const r = await client.getSwapMatches(100, 'block');
            expect(r.total).to.equal(1);
        });

        it('getSwapMatches without query returns result', async function () {
            nock(BASE).get('/BTC/api/swap_matches').reply(200, { total: 0, data: [] });
            const r = await client.getSwapMatches(null);
            expect(r.total).to.equal(0);
        });

    });
});
