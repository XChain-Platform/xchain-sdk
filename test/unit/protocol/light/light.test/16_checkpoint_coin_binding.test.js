/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const light = require('../../../../../src/protocol/light_client.js');

const checkpoint = {
    chain: 'LTC', network: 'testnet', block_index: 10,
    state_root: '11'.repeat(32), block_merkle_root: '22'.repeat(32)
};

function serve(proof) {
    return async () => ({ ok: true, status: 200, json: async () => ({ proof }) });
}

function balanceProof() {
    return { chain: 'LTC', network: 'testnet', height: 10 };
}

function actionProof() {
    return { chain: 'LTC', network: 'testnet', height: 10, action: 'ISSUE', action_index: 7, tx_index: 8 };
}

describe('online verifier checkpoint coin binding', function () {
    it('refuses a trusted balance checkpoint from another requested chain', async function () {
        const result = await light.verifyBalance({ explorerUrl: '', coin: 'TBTC',
            address: 'address', tick: 'TICK', trustedCheckpoint: checkpoint,
            fetchImpl: serve(balanceProof()) });
        assert.strictEqual(result.verified, false);
        assert.strictEqual(result.reason, 'CHECKPOINT_COIN_MISMATCH');
        assert.strictEqual(result.quorum, null);
    });

    it('refuses a trusted locked-balance checkpoint from another requested chain', async function () {
        const result = await light.verifyLockedBalance({ explorerUrl: '', coin: 'TBTC',
            address: 'address', tick: 'TICK', trustedCheckpoint: checkpoint,
            fetchImpl: serve(balanceProof()) });
        assert.strictEqual(result.verified, false);
        assert.strictEqual(result.reason, 'CHECKPOINT_COIN_MISMATCH');
        assert.strictEqual(result.quorum, null);
    });

    it('refuses a trusted action checkpoint from another requested chain', async function () {
        const result = await light.verifyAction({ explorerUrl: '', coin: 'TBTC', actionIndex: 7,
            trustedCheckpoint: checkpoint, fetchImpl: serve(actionProof()) });
        assert.strictEqual(result.verified, false);
        assert.strictEqual(result.reason, 'CHECKPOINT_COIN_MISMATCH');
        assert.strictEqual(result.quorum, null);
    });

    it('fails closed for an unknown requested coin', async function () {
        const result = await light.verifyBalance({ explorerUrl: '', coin: 'NOPE',
            address: 'address', tick: 'TICK', trustedCheckpoint: checkpoint,
            fetchImpl: serve(balanceProof()) });
        assert.strictEqual(result.verified, false);
        assert.strictEqual(result.reason, 'UNKNOWN_COIN');
    });
});
