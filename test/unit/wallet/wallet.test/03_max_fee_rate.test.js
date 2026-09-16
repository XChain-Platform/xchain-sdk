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
const WalletUtils = require('../../../../src/utils/wallet.js');

describe('WalletUtils', function() {

    describe('resolveMaxFeeRate()', function() {
        // bitcoinjs's 5000 sat/vB "absurd fee" default is calibrated for
        // BTC's unit value; ordinary DOGE fees (~0.5 DOGE/kB estimator
        // rates) exceed it and failed every live mainnet ANCHOR signing.

        it('keeps the bitcoinjs default on bitcoin networks', function() {
            expect(new WalletUtils('bitcoin-mainnet').resolveMaxFeeRate()).to.equal(null);
            expect(new WalletUtils('bitcoin-regtest').resolveMaxFeeRate()).to.equal(null);
        });

        it('raises the ceiling on non-bitcoin networks', function() {
            expect(new WalletUtils('dogecoin-mainnet').resolveMaxFeeRate()).to.equal(10000000);
            expect(new WalletUtils('litecoin-mainnet').resolveMaxFeeRate()).to.equal(10000000);
        });

        it('honors an explicit opts.maximumFeeRate on any network', function() {
            expect(new WalletUtils('bitcoin-mainnet').resolveMaxFeeRate({ maximumFeeRate: 250 })).to.equal(250);
            expect(new WalletUtils('dogecoin-mainnet').resolveMaxFeeRate({ maximumFeeRate: 99 })).to.equal(99);
        });

        it('ignores non-finite or non-positive overrides', function() {
            const w = new WalletUtils('dogecoin-mainnet');
            expect(w.resolveMaxFeeRate({ maximumFeeRate: 0 })).to.equal(10000000);
            expect(w.resolveMaxFeeRate({ maximumFeeRate: NaN })).to.equal(10000000);
        });
    });
});
