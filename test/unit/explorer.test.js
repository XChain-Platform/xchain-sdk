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
const ExplorerClient = require('../../src/clients/explorer.js');

describe('ExplorerClient', function () {

    const BASE = 'http://explorer.test:8080';
    let client;

    beforeEach(function () {
        client = new ExplorerClient({
            network: 'bitcoin-mainnet',
            explorerUrl: 'explorer.test',
            explorerPort: 8080,
            retry: false
        });
    });

    afterEach(function () {
        nock.cleanAll();
    });

    describe('fileRawUrl()', function () {
        it('builds the absolute raw FILE URL for the configured explorer', function () {
            expect(client.fileRawUrl(123)).to.equal('http://explorer.test:8080/BTC/api/file/123/raw');
        });
        it('respects an http(s) baseUrl and strips trailing slashes', function () {
            let c = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'https://explorer.xchain.io/', retry: false });
            expect(c.fileRawUrl('7')).to.equal('https://explorer.xchain.io/RBTC/api/file/7/raw');
        });
        it('resolves a sibling-chain coin at the same network tier', function () {
            // Mainnet client: DOGE → DOGE
            expect(client.fileRawUrl(9, 'DOGE')).to.equal('http://explorer.test:8080/DOGE/api/file/9/raw');
            // Regtest client: DOGE → RDOGE (tier implied by the client's network)
            let c = new ExplorerClient({ network: 'bitcoin-regtest', explorerUrl: 'https://explorer.xchain.io/', retry: false });
            expect(c.fileRawUrl('7', 'doge')).to.equal('https://explorer.xchain.io/RDOGE/api/file/7/raw');
        });
    });

    describe('coin prefix', function () {
        const cases = {
            'bitcoin-mainnet': 'BTC', 'bitcoin-testnet': 'TBTC', 'bitcoin-regtest': 'RBTC',
            'litecoin-mainnet': 'LTC', 'litecoin-testnet': 'TLTC', 'litecoin-regtest': 'RLTC',
            'dogecoin-mainnet': 'DOGE', 'dogecoin-testnet': 'TDOGE', 'dogecoin-regtest': 'RDOGE'
        };
        for (let [network, prefix] of Object.entries(cases)) {
            it(network + ' → ' + prefix, function () {
                let c = new ExplorerClient({ network });
                expect(c.coin).to.equal(prefix);
            });
        }

        it('throws on invalid network', function () {
            expect(() => new ExplorerClient({ network: 'invalid' })).to.throw(/Unknown network/);
        });

        it('defaults to BTC when no network', function () {
            let c = new ExplorerClient({});
            expect(c.coin).to.equal('BTC');
        });
    });

});
