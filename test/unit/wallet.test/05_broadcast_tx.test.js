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

describe('WalletUtils', function() {

    describe('broadcastTx()', function() {
        it('should throw without encoder', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.broadcastTx('aabbcc', null);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('ENCODER_REQUIRED');
            }
        });

        it('should throw on empty txHex', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.broadcastTx('', {});
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('INVALID_TX_HEX');
            }
        });
    });
});
