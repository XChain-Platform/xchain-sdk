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

    describe('buildParams additional params', function () {
        it('passes start, length, tick, txid, blockIndex params', async function () {
            nock(BASE)
                .get('/BTC/api/balances/addr1')
                .query({ start: '0', length: '100', tick: 'TOKEN', txid: 'abc', blockIndex: '500' })
                .reply(200, { data: [] });
            const r = await client.getBalances('addr1', {
                start: 0, length: 100, tick: 'TOKEN', txid: 'abc', blockIndex: 500
            });
            expect(r).to.have.property('data');
        });
    });
});
