// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');
const {
    PUBLIC_HUB, PUBLIC_EXPLORER, PUBLIC_ENCODER,
    isRegtest, coinPrefix, publicDefaults
} = require('../../src/endpoints.js');

describe('endpoints', function () {

    describe('constants', function () {
        it('public hosts are full https URLs', function () {
            expect(PUBLIC_HUB).to.equal('https://hub.xchain.io');
            expect(PUBLIC_EXPLORER).to.equal('https://explorer.xchain.io');
            expect(PUBLIC_ENCODER).to.equal('https://encoder.xchain.io');
        });
    });

    describe('isRegtest()', function () {
        it('true only for *-regtest', function () {
            expect(isRegtest('bitcoin-regtest')).to.equal(true);
            expect(isRegtest('litecoin-regtest')).to.equal(true);
            expect(isRegtest('bitcoin-mainnet')).to.equal(false);
            expect(isRegtest('dogecoin-testnet')).to.equal(false);
        });
        it('false for null/undefined/garbage', function () {
            expect(isRegtest(null)).to.equal(false);
            expect(isRegtest(undefined)).to.equal(false);
            expect(isRegtest('')).to.equal(false);
        });
    });

    describe('coinPrefix()', function () {
        const cases = {
            'bitcoin-mainnet': 'BTC', 'bitcoin-testnet': 'TBTC', 'bitcoin-regtest': 'RBTC',
            'litecoin-mainnet': 'LTC', 'litecoin-testnet': 'TLTC', 'litecoin-regtest': 'RLTC',
            'dogecoin-mainnet': 'DOGE', 'dogecoin-testnet': 'TDOGE', 'dogecoin-regtest': 'RDOGE'
        };
        for (let [network, prefix] of Object.entries(cases)) {
            it(network + ' -> ' + prefix, function () {
                expect(coinPrefix(network)).to.equal(prefix);
            });
        }
        it('matches explorer.js coin derivation (single source of truth)', function () {
            const ExplorerClient = require('../../src/explorer.js');
            for (let [network, prefix] of Object.entries(cases)) {
                expect(new ExplorerClient({ network }).coin).to.equal(prefix);
            }
        });
        it('strict: rejects unknown chain or network part', function () {
            expect(coinPrefix('ethereum-mainnet')).to.equal(null);
            expect(coinPrefix('bitcoin-foo')).to.equal(null);
            expect(coinPrefix('bitcoin')).to.equal(null);
            expect(coinPrefix('bitcoin-')).to.equal(null);
            expect(coinPrefix('invalid')).to.equal(null);
            expect(coinPrefix(null)).to.equal(null);
            expect(coinPrefix(undefined)).to.equal(null);
        });
    });

    describe('publicDefaults()', function () {
        it('non-regtest carries the /{COIN} segment on encoder + hub, bare explorer', function () {
            expect(publicDefaults('bitcoin-mainnet')).to.deep.equal({
                hubUrl:      'https://hub.xchain.io/BTC',
                explorerUrl: 'https://explorer.xchain.io',
                encoderUrl:  'https://encoder.xchain.io/BTC'
            });
            expect(publicDefaults('dogecoin-testnet')).to.deep.equal({
                hubUrl:      'https://hub.xchain.io/TDOGE',
                explorerUrl: 'https://explorer.xchain.io',
                encoderUrl:  'https://encoder.xchain.io/TDOGE'
            });
        });
        it('regtest returns {} (clients fall back to localhost)', function () {
            expect(publicDefaults('bitcoin-regtest')).to.deep.equal({});
            expect(publicDefaults('litecoin-regtest')).to.deep.equal({});
        });
        it('missing/unknown network returns {}', function () {
            expect(publicDefaults(null)).to.deep.equal({});
            expect(publicDefaults('bitcoin-foo')).to.deep.equal({});
        });
    });

});
