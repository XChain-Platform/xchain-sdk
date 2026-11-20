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
// A settle gate over a contract too large for one explorer page reads the key
// across pages, and waits longer between polls in proportion to the requests the
// read spent so the explorer's per-address request limit still holds.

const { expect } = require('chai');
const nock = require('nock');
const ActionWaiter = require('../../../src/utils/action_waiter.js');
const ExplorerClient = require('../../../src/clients/explorer.js');

const BASE = 'http://explorer.test:8080';
const STATE = '/BTC/api/contract/7/state/zz_status';

function rowsFor(extra) {
    const rows = Array.from({ length: 230 }, (_, i) => ({ state_key: 'k' + String(i).padStart(4, '0'), state_value: '1' }));
    return extra ? rows.concat([extra]) : rows;
}

// The explorer's behaviour: a bare read is a 25-row page, and a paged read honours page and limit.
function serve(rows, stamps) {
    nock(BASE).persist().get(STATE).query(true).reply(200, (request) => {
        const params = new URL(request.url).searchParams;
        stamps.push(Date.now());
        if (!params.has('page')) return { total: rows.length, data: rows.slice(0, 25) };
        const page = Number(params.get('page'));
        const limit = Number(params.get('limit'));
        return { total: rows.length, data: rows.slice((page - 1) * limit, page * limit) };
    });
}

function waiterOver(explorer) {
    return new ActionWaiter({ ws: null, requireExplorer: () => explorer });
}

describe('ActionWaiter contract state gate over a paged listing', function () {
    let explorer;
    beforeEach(function () {
        explorer = new ExplorerClient({ network: 'bitcoin-mainnet', explorerUrl: 'explorer.test', explorerPort: 8080, retry: false });
    });
    afterEach(nock.cleanAll);

    it('resolves when the watched key sorts past the first page', async function () {
        serve(rowsFor({ state_key: 'zz_status', state_value: '"FUNDED"' }), []);
        const result = await waiterOver(explorer).waitForContractState(7,
            { key: 'zz_status', equals: 'FUNDED', timeout: 3000, pollInterval: 20 });
        expect(result.value).to.equal('FUNDED');
    });

    it('spaces the polls of a multi-request read by the requests it spent', async function () {
        const stamps = [];
        serve(rowsFor(), stamps);
        let caught = null;
        try {
            await waiterOver(explorer).waitForContractState(7, { key: 'zz_status', equals: 'FUNDED', timeout: 500, pollInterval: 50 });
        } catch (err) {
            caught = err;
        }
        expect(caught && caught.code).to.equal('CONTRACT_STATE_TIMEOUT');
        // Each poll is one bare read plus three pages, so unpaced it would poll about ten times.
        const polls = stamps.length / 4;
        expect(polls).to.be.at.most(4);
        expect(polls).to.be.at.least(2);
    });
});
