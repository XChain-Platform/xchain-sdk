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

    describe('readyHook', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('awaits readyHook before each GET request', async function () {
            let hookCalled = false;
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                readyHook: async () => { hookCalled = true; }
            });
            nock(BASE).get('/BTC/api/status').reply(200, { status: 'ok' });
            await hooked.getStatus();
            expect(hookCalled).to.be.true;
        });

        it('search uses the base selected by readyHook', async function () {
            let hooked;
            hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: '127.0.0.1',
                explorerPort: 18080,
                retry: false,
                readyHook: async () => { hooked.setBase('127.0.0.1', 19090); }
            });
            nock('http://127.0.0.1:18080')
                .get('/BTC/explorer/search/abc/tx').reply(200, { host: 'provisional' });
            const discovered = nock('http://127.0.0.1:19090')
                .get('/BTC/explorer/search/abc/tx').reply(200, { host: 'discovered' });

            expect(await hooked.search('abc', 'tx')).to.deep.equal({ host: 'discovered' });
            expect(discovered.isDone()).to.be.true;
        });

        it('getGatedFileRaw uses the base selected by readyHook', async function () {
            let hooked;
            hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: '127.0.0.1',
                explorerPort: 18080,
                retry: false,
                readyHook: async () => { hooked.setBase('127.0.0.1', 19090); }
            });
            nock('http://127.0.0.1:18080')
                .get('/BTC/api/file/7/raw').reply(200, Buffer.from([9]));
            const discovered = nock('http://127.0.0.1:19090')
                .get('/BTC/api/file/7/raw').reply(200, Buffer.from([1, 2, 3]));

            expect(await hooked.getGatedFileRaw(7)).to.deep.equal(Buffer.from([1, 2, 3]));
            expect(discovered.isDone()).to.be.true;
        });
    });
});
