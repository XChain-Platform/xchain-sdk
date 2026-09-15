// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const sinon = require('sinon');

const LifecycleManager = require('../../../src/carrier/lifecycle_manager.js');
const WalletSession = require('../../../src/utils/wallet_session.js');

const WIF_MAINNET = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73NUBBy7N';

const fakeKeyInfo = {
    publicKeyHex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    publicKey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
    compressed: true
};

function makeSdk(overrides = {}) {
    let encoder = {
        getUTXOs: async (address) => ({ utxos: [{ txid: 'utxo1', vout: 0, value: 100000 }] })
    };
    return {
        wallet: {
            importWIF:     () => fakeKeyInfo,
            deriveAddress: () => 'mTestAddr123'
        },
        _requireEncoder: () => encoder,
        getBalances:    async (addr, opts) => [{ tick: 'TOK', quantity: '100' }],
        getHistory:     async (addr, type, opts) => [{ action: 'SEND' }],
        getCredits:     async (addr, type, opts) => [{ credit: 1 }],
        getDebits:      async (addr, type, opts) => [{ debit: 1 }],
        getSends:       async (addr, type, opts) => [{ send: 1 }],
        getOrders:      async (addr, type, opts) => [{ order: 1 }],
        getSwaps:       async (addr, type, opts) => [{ swap: 1 }],
        getDispensers:  async (addr, type, opts) => [{ dispenser: 1 }],
        estimateFees:   async (actionData, enc) => ({ fee: 1000 }),
        ...overrides
    };
}

/*
 *  estimateFees()
 */

describe('WalletSession', function () {
    beforeEach(function () {
        sinon.stub(LifecycleManager.prototype, 'submitAction')
            .resolves({ txid: 'faketx1', status: 'broadcast', spentInputs: [{ txid: 'utxo1', vout: 0 }] });
    });
    afterEach(function () { sinon.restore(); });

    describe('estimateFees()', function () {
        it('calls sdk.estimateFees with merged pubkey/change', async function () {
            let capturedEnc;
            let sdk = makeSdk({
                estimateFees: async (actionData, enc) => { capturedEnc = enc; return { fee: 5000 }; }
            });
            let session = new WalletSession(sdk, WIF_MAINNET);
            let result = await session.estimateFees({ action: 'SEND', params: {} });
            assert.strictEqual(result.fee, 5000);
            assert.strictEqual(capturedEnc.pubkey, 'mTestAddr123');
            assert.strictEqual(capturedEnc.change, 'mTestAddr123');
        });

        it('merges caller-provided encoderOpts', async function () {
            let capturedEnc;
            let sdk = makeSdk({
                estimateFees: async (actionData, enc) => { capturedEnc = enc; return { fee: 1000 }; }
            });
            let session = new WalletSession(sdk, WIF_MAINNET);
            await session.estimateFees({ action: 'SEND', params: {} }, { encoding: 'P2SH' });
            assert.strictEqual(capturedEnc.encoding, 'P2SH');
        });
    });
});
