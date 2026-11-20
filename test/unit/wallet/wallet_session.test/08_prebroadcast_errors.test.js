// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const WalletSession = require('../../../../src/utils/wallet_session.js');

const KEY = {
    publicKeyHex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    publicKey: Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
    compressed: true,
};

describe('WalletSession pre-broadcast errors', () => {
    it('marks a UTXO load failure before LifecycleManager is entered', async () => {
        const sdk = {
            wallet: { importWIF: () => KEY, deriveAddress: () => 'sender' },
            requireEncoder: () => ({ getUTXOs: async () => {
                throw Object.assign(new Error('tracker down'), { details: {} });
            } }),
        };
        const session = new WalletSession(sdk, 'WIF');
        await assert.rejects(
            session.submit({ action: 'SEND', params: {} }),
            (error) => error.preBroadcast === true && error.details.preBroadcast === true);
    });
});
