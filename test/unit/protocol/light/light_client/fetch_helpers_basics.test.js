/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain SDK - Light client fetch helper basics
 *
 * Pure unit tests for the small string and context helpers in
 * fetch_helpers.js.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const H = require('../../../../../src/protocol/light_client/fetch_helpers.js');

describe('light_client fetch_helpers basics', function () {
    describe('resolveFetch', function () {
        it('returns the implementation given', function () {
            const impl = function () {};
            expect(H.resolveFetch(impl)).to.equal(impl);
        });

        it('throws when none is given and global fetch is absent', function () {
            const saved = globalThis.fetch;
            try {
                delete globalThis.fetch;
                expect(() => H.resolveFetch()).to.throw('LightClient: no fetch implementation available');
            } finally {
                globalThis.fetch = saved;
            }
        });
    });

    describe('networkContextCoin', function () {
        it('returns the field when set', function () {
            expect(H.networkContextCoin({ coin: 'ltc', network: 'regtest' }, 'coin', 'btc')).to.equal('ltc');
        });

        it('returns the mainnet coin for mainnet or no network', function () {
            expect(H.networkContextCoin({ network: 'mainnet' }, 'coin', 'btc')).to.equal('btc');
            expect(H.networkContextCoin({}, 'coin', 'btc')).to.equal('btc');
            expect(H.networkContextCoin(null, 'coin', 'btc')).to.equal('btc');
        });

        it('throws for testnet and regtest without a coin', function () {
            expect(() => H.networkContextCoin({ network: 'bitcoin-testnet' }, 'coin', 'btc'))
                .to.throw('LightClient: coin is required for testnet network context');
            expect(() => H.networkContextCoin({ network: 'regtest' }, 'coin', 'btc'))
                .to.throw('LightClient: coin is required for regtest network context');
        });

        it('uses the fallback network when opts.network is null', function () {
            expect(() => H.networkContextCoin({ network: null }, 'coin', 'btc', 'regtest'))
                .to.throw('LightClient: coin is required for regtest network context');
            expect(H.networkContextCoin({ network: null }, 'coin', 'btc', 'mainnet')).to.equal('btc');
        });
    });

    describe('baseUrl, lowerHex, unverified', function () {
        it('trims trailing slashes and maps null to empty', function () {
            expect(H.baseUrl('http://x///')).to.equal('http://x');
            expect(H.baseUrl(null)).to.equal('');
        });

        it('lowercases and maps null to empty while keeping 0', function () {
            expect(H.lowerHex('AbC')).to.equal('abc');
            expect(H.lowerHex(null)).to.equal('');
            expect(H.lowerHex(0)).to.equal('0');
        });

        it('builds the unverified result', function () {
            expect(H.unverified('why')).to.deep.equal({ verified: false, amount: null, reason: 'why' });
        });
    });
});
