/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const checkpoint = require('../../../../../src/checkpoint.js');
const { verifyAnchoredCheckpoint } = require('../../../../../src/protocol/light_client/anchored_checkpoint.js');
const { clearValidatorSetCache, explorerValidators, resolveValidatorSet } =
    require('../../../../../src/protocol/light_client/quorum_resolution.js');

function signer(weight = '1') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const pubkey = der.subarray(der.length - 32).toString('hex');
    return { privateKey, validator: { pubkey, source: pubkey, weight } };
}

const members = [signer(), signer(), signer()];
const validators = members.map((member) => member.validator);
const archiveValidators = validators.slice(0, 2);

function foldedCheckpoint(network = 'regtest') {
    const cp = {
        chain: 'BTC', network, block_index: 100, block_hash: '10'.repeat(32),
        ledger_hash: '20'.repeat(32), actions_hash: '30'.repeat(32), contract_hash: '40'.repeat(32),
        checkpoint_seq: 7, snapshot_block: 100, state_root: '50'.repeat(32), state_root_version: 1,
        block_merkle_root: '60'.repeat(32), block_merkle_version: 1,
        fold_archive: { match_batch_seq: 8, match_count: 9, batch_crc32: '1234abcd', total_chunks: 1 }
    };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    cp.validator_signatures = members.slice(0, 2).map((member) => ({
        pubkey: member.validator.pubkey,
        sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), member.privateKey).toString('hex')
    }));
    return cp;
}

function response(body, calls) {
    return async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => body };
    };
}

describe('fold wrapper explorer validator set', function () {
    beforeEach(function () { clearValidatorSetCache(); });

    it('uses archive_validators above the gate and keeps its cache entry distinct from a plain section', async function () {
        const calls = [];
        const fetchImpl = response({ validators, archive_validators: archiveValidators }, calls);
        const folded = foldedCheckpoint();
        const plain = Object.assign({}, folded);
        delete plain.fold_archive;

        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', folded), archiveValidators);
        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', plain), validators);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0], calls[1]);
        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', folded), archiveValidators);
        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', plain), validators);
        assert.strictEqual(calls.length, 2);
    });

    it('keeps plain sections and pre-gate fold wrappers on validators', async function () {
        const calls = [];
        const fetchImpl = response({ validators, archive_validators: archiveValidators }, calls);
        const plain = foldedCheckpoint();
        delete plain.fold_archive;
        const preGate = foldedCheckpoint('testnet');

        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'TBTC', plain), validators);
        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'TBTC', preGate), validators);
        assert.strictEqual(calls.length, 1);
    });

    it('does not fall back to validators when archive_validators is absent above the gate', async function () {
        const calls = [];
        const resolved = await explorerValidators(response({ validators }, calls), 'https://x', 'RBTC', foldedCheckpoint());
        assert.deepStrictEqual(resolved, []);
        assert.strictEqual(calls.length, 1);
    });

    it('keeps the full pinned set and returns CHECKPOINT_QUORUM_FAILED instead of downgrading', async function () {
        const cp = foldedCheckpoint();
        let fetched = false;
        const resolved = await resolveValidatorSet(async () => { fetched = true; }, {
            explorerUrl: 'https://x',
            pinnedResolver: () => ({ checkpoint: cp, validators })
        }, cp, 'RBTC');

        assert.deepStrictEqual(resolved, validators);
        assert.strictEqual(fetched, false);
        const result = verifyAnchoredCheckpoint({ checkpoint: cp, validators: resolved, confirmations: 100 });
        assert.strictEqual(result.verified, false);
        assert.strictEqual(result.reason, 'CHECKPOINT_QUORUM_FAILED');
    });
});
