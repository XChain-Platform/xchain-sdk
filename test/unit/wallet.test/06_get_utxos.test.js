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
const WalletUtils = require('../../../src/utils/wallet.js');

describe('WalletUtils', function() {

    describe('getUTXOs()', function() {
        afterEach(() => sinon.restore());

        it('should throw without encoder', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.getUTXOs('addr', null);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('ENCODER_REQUIRED');
            }
        });

        it('should throw on empty address', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            try {
                await wallet.getUTXOs('', {});
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('INVALID_ADDRESS');
            }
        });

        it('should return utxos array from encoder.getUTXOs({utxos:[...]})', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { getUTXOs: async () => ({ utxos: [{ txid: 'abc', vout: 0, value: 1000 }] }) };
            const result = await wallet.getUTXOs('mTestAddr', encoder);
            expect(result).to.be.an('array').with.lengthOf(1);
            expect(result[0].txid).to.equal('abc');
        });
    });
});

describe('WalletUtils', function() {

    describe('getUTXOs()', function() {
        afterEach(() => sinon.restore());

        it('should return raw array when encoder.getUTXOs returns array directly', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { getUTXOs: async () => [{ txid: 'xyz', vout: 1, value: 500 }] };
            const result = await wallet.getUTXOs('mTestAddr', encoder);
            expect(result).to.be.an('array').with.lengthOf(1);
            expect(result[0].txid).to.equal('xyz');
        });

        it('should wrap non-SDK errors as UTXO_FETCH_FAILED', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const encoder = { getUTXOs: async () => { throw new Error('network error'); } };
            try {
                await wallet.getUTXOs('mTestAddr', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('UTXO_FETCH_FAILED');
            }
        });

        it('should re-throw SDK errors from encoder.getUTXOs', async function() {
            const wallet = new WalletUtils('bitcoin-regtest');
            const { SDKWalletError } = require('../../../src/utils/errors.js');
            const sdkErr = new SDKWalletError('SOME_CODE', 'sdk error');
            const encoder = { getUTXOs: async () => { throw sdkErr; } };
            try {
                await wallet.getUTXOs('mTestAddr', encoder);
                expect.fail('should have thrown');
            } catch (err) {
                expect(err.code).to.equal('SOME_CODE');
            }
        });
    });
});
