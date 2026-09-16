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
const sinon = require('sinon');
const WalletUtils = require('../../../../src/utils/wallet.js');

describe('WalletUtils', function() {

    describe('broadcastTx() - success and error paths', function() {
        afterEach(() => sinon.restore());

        it('should return txid from encoder.broadcastTx', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { broadcastTx: async (hex) => ({ txid: 'deadbeef1234' }) };
            const result = await wallet.broadcastTx('aabbcc', encoder);
            expect(result.txid).to.equal('deadbeef1234');
        });

        it('should wrap non-SDK errors as BROADCAST_FAILED', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { broadcastTx: async () => { throw new Error('mempool full'); } };
            try {
                await wallet.broadcastTx('aabbcc', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('BROADCAST_FAILED');
            }
        });

        it('should re-throw SDK errors from encoder.broadcastTx', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const { SDKWalletError } = require('../../../../src/utils/errors.js');
            const sdkErr = new SDKWalletError('SOME_BROADCAST_ERR', 'sdk-level error');
            const encoder = { broadcastTx: async () => { throw sdkErr; } };
            try {
                await wallet.broadcastTx('aabbcc', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('SOME_BROADCAST_ERR');
            }
        });
    });
});
