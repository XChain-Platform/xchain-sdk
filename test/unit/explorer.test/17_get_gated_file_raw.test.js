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

    describe('getGatedFileRaw', function () {
        it('returns Buffer from arraybuffer response', async function () {
            const fakeBytes = Buffer.from([0x01, 0x02, 0x03]);
            nock(BASE)
                .get('/BTC/api/file/42/raw')
                .reply(200, fakeBytes, { 'content-type': 'application/octet-stream' });

            const result = await client.getGatedFileRaw(42);
            expect(result).to.be.instanceof(Buffer);
        });

        it('fires onRequest/onResponse hooks for gatedFile', async function () {
            const onRequest = sinon.spy();
            const onResponse = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onRequest, onResponse }
            });
            const fakeBytes = Buffer.from([0xaa]);
            nock(BASE)
                .get('/BTC/api/file/99/raw')
                .reply(200, fakeBytes, { 'content-type': 'application/octet-stream' });

            await hooked.getGatedFileRaw(99);
            expect(onRequest.calledOnce).to.be.true;
            expect(onResponse.calledOnce).to.be.true;
        });

        it('fires onError hook for gatedFile error', async function () {
            const onError = sinon.spy();
            const hooked = new ExplorerClient({
                network: 'bitcoin-mainnet',
                explorerUrl: 'explorer.test',
                explorerPort: 8080,
                retry: false,
                hooks: { onError }
            });
            nock(BASE).get('/BTC/api/file/99/raw').reply(404, 'not found');
            try { await hooked.getGatedFileRaw(99); } catch (e) { /* expected */ }
            expect(onError.calledOnce).to.be.true;
        });
    });
});
