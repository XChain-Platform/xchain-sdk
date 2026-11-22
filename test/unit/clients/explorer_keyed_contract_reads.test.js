// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The explorer's contract state and balance routes answer the whole sorted set a
// page at a time and ignore the trailing key or tick segment. A keyed read has to
// find its row on a later page instead of reporting it absent.

const { expect } = require('chai');
const nock = require('nock');
const ExplorerClient = require('../../../src/clients/explorer.js');
const { SCAN_PAGE_LIMIT, SCAN_PAGE_CAP } = require('../../../src/clients/explorer/keyed_contract_read.js');

const BASE = 'http://explorer.test:8080';
const STATE = '/BTC/api/contract/7/state/zz_status';
const BALANCE = '/BTC/api/contract/7/balance/ZTICK';
let client;

function stateRows(from, count) {
    return Array.from({ length: count }, (_, i) => ({ state_key: 'k' + String(from + i).padStart(5, '0'), state_value: '1' }));
}

// Serves `rows` as the explorer does: default page for a bare read, then `limit`-sized pages.
function serve(path, rows, defaultLimit) {
    const hits = { bare: 0, pages: [] };
    nock(BASE).persist().get(path).query(true).reply(200, (request) => {
        const params = new URL(request.url).searchParams;
        if (!params.has('page')) {
            hits.bare++;
            return { total: rows.length, data: rows.slice(0, defaultLimit) };
        }
        const page = Number(params.get('page'));
        const limit = Number(params.get('limit'));
        hits.pages.push(page);
        return { total: rows.length, data: rows.slice((page - 1) * limit, page * limit) };
    });
    return hits;
}

function useClient() {
    beforeEach(function () {
        client = new ExplorerClient({ network: 'bitcoin-mainnet', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });
    });
    afterEach(nock.cleanAll);
}

describe('ExplorerClient keyed contract reads', function () {
    useClient();

    it('finds a state key that sorts past the first page', async function () {
        const rows = stateRows(0, 250).concat([{ state_key: 'zz_status', state_value: '"FUNDED"' }]);
        const hits = serve(STATE, rows, 25);
        const reply = await client.getContractState(7, 'zz_status');
        expect(reply.data.some((row) => row.state_key === 'zz_status')).to.equal(true);
        expect(hits.bare).to.equal(1);
        expect(hits.pages).to.deep.equal([1, 2, 3]);
    });

    it('finds a balance tick that sorts past the first page', async function () {
        const rows = stateRows(0, 130).map((row) => ({ tick: row.state_key, amount: '1' }));
        rows.push({ tick: 'ZTICK', amount: '42' });
        serve(BALANCE, rows, 25);
        const reply = await client.getContractBalance(7, 'ZTICK');
        expect(reply.data.find((row) => row.tick === 'ZTICK').amount).to.equal('42');
    });

    it('answers a key found on the first read without a second request', async function () {
        const rows = [{ state_key: 'zz_status', state_value: '1' }].concat(stateRows(0, 30));
        const hits = serve(STATE, rows, 100);
        await client.getContractState(7, 'zz_status');
        expect(hits.bare).to.equal(1);
        expect(hits.pages).to.deep.equal([]);
    });

    it('answers a missing key from a complete listing with the first reply and no walk', async function () {
        const hits = serve(STATE, stateRows(0, 10), 100);
        const reply = await client.getContractState(7, 'zz_status');
        expect(reply.total).to.equal(10);
        expect(hits.pages).to.deep.equal([]);
    });

    it('starts the walk at page two when the default page is already a full page', async function () {
        const rows = stateRows(0, 250).concat([{ state_key: 'zz_status', state_value: '1' }]);
        const hits = serve(STATE, rows, SCAN_PAGE_LIMIT);
        await client.getContractState(7, 'zz_status');
        expect(hits.pages).to.deep.equal([2, 3]);
    });

    it('answers a key absent from a multi-page listing with the first reply once every page is read', async function () {
        const hits = serve(STATE, stateRows(0, 230), 25);
        const reply = await client.getContractState(7, 'zz_status');
        expect(reply.data).to.have.length(25);
        expect(hits.pages).to.deep.equal([1, 2, 3]);
    });

});

describe('ExplorerClient keyed contract reads: exactness and limits', function () {
    useClient();

    it('matches the key exactly, never a row that differs by case', async function () {
        const rows = stateRows(0, 130).concat([{ state_key: 'ZZ_STATUS', state_value: '1' }]);
        const hits = serve(STATE, rows, 25);
        const reply = await client.getContractState(7, 'zz_status');
        expect(reply.data.some((row) => row.state_key === 'zz_status')).to.equal(false);
        expect(hits.pages).to.deep.equal([1, 2]);
    });

    it('throws instead of answering absent when the listing is larger than it will walk', async function () {
        const rows = stateRows(0, SCAN_PAGE_LIMIT * SCAN_PAGE_CAP + 50);
        const hits = serve(STATE, rows, 25);
        let caught = null;
        try {
            await client.getContractState(7, 'zz_status');
        } catch (err) {
            caught = err;
        }
        expect(caught && caught.code).to.equal('CONTRACT_READ_TRUNCATED');
        expect(caught.details.total).to.equal(rows.length);
        expect(hits.pages).to.have.length(SCAN_PAGE_CAP);
    });
});
