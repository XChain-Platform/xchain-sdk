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
const WalletUtils = require('../../../src/utils/wallet.js');

describe('non-bitcoin signing fee ceilings', function () {
    it('derives litecoin and dogecoin ceilings from the encoder maximum', function () {
        expect(new WalletUtils('litecoin-mainnet').resolveMaxFeeRate()).to.equal(200000);
        expect(new WalletUtils('dogecoin-mainnet').resolveMaxFeeRate()).to.equal(2000000);
        expect(new WalletUtils('dogecoin-testnet').resolveMaxFeeRate()).to.equal(2000000);
    });

    it('keeps bitcoin on the library default', function () {
        expect(new WalletUtils('bitcoin-mainnet').resolveMaxFeeRate()).to.equal(null);
    });

    it('keeps the maximumFeeRate override', function () {
        expect(new WalletUtils('litecoin-mainnet').resolveMaxFeeRate({ maximumFeeRate: 77 })).to.equal(77);
        expect(new WalletUtils('dogecoin-mainnet').resolveMaxFeeRate({ maximumFeeRate: 5 })).to.equal(5);
    });
});
