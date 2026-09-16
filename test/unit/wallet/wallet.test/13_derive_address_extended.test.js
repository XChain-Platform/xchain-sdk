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

    describe('deriveAddress() - extended', function() {
        it('should throw INVALID_ADDRESS_TYPE for unknown type', function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const kp = wallet.generateKeyPair();
            expect(() => wallet.deriveAddress(kp.publicKey, { type: 'p2tr' })).to.throw(/Unknown address type/);
        });
    });
});
