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

    describe('setBase', function () {
        it('no-ops when both url and port are falsy', function () {
            const origClient = client.client;
            client.setBase(null, null);
            expect(client.client).to.equal(origClient);
        });

        it('no-ops when url/port unchanged', function () {
            const origClient = client.client;
            client.setBase('explorer.test', 8080);
            expect(client.client).to.equal(origClient);
        });

        it('rebuilds client when url changes', function () {
            const origClient = client.client;
            client.setBase('new-explorer.test', 8080);
            expect(client.client).to.not.equal(origClient);
            expect(client.baseUrl).to.equal('new-explorer.test');
        });

        it('rebuilds client when port changes', function () {
            const origClient = client.client;
            client.setBase('explorer.test', 9090);
            expect(client.client).to.not.equal(origClient);
            expect(client.port).to.equal(9090);
        });
    });
});
