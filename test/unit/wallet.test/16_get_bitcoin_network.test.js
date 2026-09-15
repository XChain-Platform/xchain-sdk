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
const { getNetwork } = require('../../../src/protocol/networks.js');

describe('WalletUtils', function() {

    describe('getBitcoinNetwork()', function() {
        it('returns the configured network params', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            expect(wallet.getBitcoinNetwork()).to.equal(getNetwork('bitcoin-regtest'));
        });

        it('resolves a different network by name without a second SDK', function() {
            const wallet = new WalletUtils('bitcoin-mainnet');
            expect(wallet.getBitcoinNetwork('litecoin-mainnet')).to.equal(getNetwork('litecoin-mainnet'));
        });

        it('returns null when constructed without a network', function() {
            const wallet = new WalletUtils();
            expect(wallet.getBitcoinNetwork()).to.equal(null);
        });
    });
});
