'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Checkpoint supersession signing, anchored reporting and refusal coverage.

const assert = require('assert');
const crypto = require('crypto');
const Checkpoint = require('../../../src/checkpoint.js');
const Anchored = require('../../../src/protocol/light_client/anchored_checkpoint.js');

const RULES_DIGEST = 'CD'.repeat(32);

function makeKeypair() {
    const pair = crypto.generateKeyPairSync('ed25519');
    const pubDer = pair.publicKey.export({ format: 'der', type: 'spki' });
    return { pubkey: pubDer.slice(12).toString('hex'), privateKey: pair.privateKey };
}

function sign(privateKey, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');
}

function checkpointRow(key, overrides = {}) {
    const row = Object.assign({
        version: 0,
        chain: 'BTC',
        network: 'regtest',
        block_index: 120,
        block_hash: '11'.repeat(32),
        ledger_hash: '22'.repeat(32),
        actions_hash: '33'.repeat(32),
        contract_hash: '44'.repeat(32),
        checkpoint_seq: 125,
        snapshot_block: 125,
        state_root: '55'.repeat(32),
        state_root_version: 1,
        block_merkle_root: '66'.repeat(32),
        block_merkle_version: 1,
        supersedes_from: '100',
        rules_digest: RULES_DIGEST,
        superseded_by_seq: null,
        block_index_doge: 200,
        tx_hash: '77'.repeat(32)
    }, overrides);
    const cp = Anchored.anchorToCheckpoint(row);
    row.validator_signatures = [{
        pubkey: key.pubkey,
        sig: sign(key.privateKey, Checkpoint.canonicalCheckpoint(cp))
    }];
    return row;
}

function validators(key) {
    return [{ pubkey: key.pubkey, weight: '1', source: 'validator-1' }];
}

async function fetchRow(row, key, overrides = {}) {
    return Anchored.fetchAnchoredCheckpoint(Object.assign({
        explorerUrl: 'https://example.invalid',
        dogeCoin: 'RDOGE',
        targetChain: 'BTC',
        validators: validators(key),
        dogeTipHeight: 200,
        dogeTxHeight: 200,
        minDepth: 1,
        fetchImpl: async () => ({ ok: true, json: async () => [row] })
    }, overrides));
}

describe('checkpoint supersede integration @regression @tier1', function () {
    it('verifies and reports a gated superseding checkpoint', async function () {
        const key = makeKeypair();
        const row = checkpointRow(key);
        const cp = Anchored.anchorToCheckpoint(row);
        const canonical = Checkpoint.canonicalCheckpoint(cp);

        assert.ok(canonical.includes(
            '|' + '55'.repeat(32) + '|1|' + '66'.repeat(32) + '|1|SUPERSEDE|100|' +
            RULES_DIGEST.toLowerCase()
        ));
        const oldCanonical = Checkpoint.canonicalCheckpoint(Object.assign({}, cp, {
            supersedes_from: null, rules_digest: null
        }));
        const oldSignature = Object.assign({}, cp, { validator_signatures: [{
            pubkey: key.pubkey, sig: sign(key.privateKey, oldCanonical)
        }] });
        assert.strictEqual(Checkpoint.verifyCheckpoint(oldSignature, validators(key)).valid, false);

        const result = await fetchRow(row, key);
        assert.strictEqual(result.verified, true);
        assert.strictEqual(result.supersedes_from, 100);
        assert.strictEqual(result.rules_digest, RULES_DIGEST.toLowerCase());
        assert.strictEqual(result.superseded_by_seq, null);
    });

    it('refuses a superseded row unless allowSuperseded is true', async function () {
        const key = makeKeypair();
        const row = checkpointRow(key, { superseded_by_seq: '130' });

        const refused = await fetchRow(row, key);
        assert.strictEqual(refused.verified, false);
        assert.strictEqual(refused.reason, 'CHECKPOINT_SUPERSEDED');
        assert.strictEqual(refused.superseded_by_seq, 130);

        const allowed = await fetchRow(row, key, { allowSuperseded: true });
        assert.strictEqual(allowed.verified, true);
        assert.strictEqual(allowed.superseded_by_seq, 130);
    });

    it('keeps plain checkpoint canonical bytes and verification unchanged', async function () {
        const key = makeKeypair();
        const cp = {
            chain: 'BTC', network: 'mainnet', block_index: 900123,
            block_hash: 'ab'.repeat(32), ledger_hash: 'cd'.repeat(32),
            actions_hash: 'ef'.repeat(32), contract_hash: '01'.repeat(32),
            checkpoint_seq: 417, snapshot_block: 900120
        };
        const canonical = 'XCHECKPOINT|BTC|mainnet|900123|' + 'ab'.repeat(32) + '|' +
            'cd'.repeat(32) + '|' + 'ef'.repeat(32) + '|' + '01'.repeat(32) + '|417|900120';
        assert.strictEqual(Checkpoint.canonicalCheckpoint(cp), canonical);
        cp.validator_signatures = [{ pubkey: key.pubkey, sig: sign(key.privateKey, canonical) }];
        assert.strictEqual(Checkpoint.verifyCheckpoint(cp, [key.pubkey]).valid, true);

        const row = checkpointRow(key, { supersedes_from: null, rules_digest: null });
        const fetched = await fetchRow(row, key);
        assert.strictEqual(fetched.verified, true);
        assert.strictEqual(fetched.supersedes_from, null);
        assert.strictEqual(fetched.rules_digest, null);
        assert.strictEqual(fetched.superseded_by_seq, null);
    });

    it('refuses supersession fields below the activation gate', function () {
        const key = makeKeypair();
        const cp = {
            chain: 'BTC', network: 'mainnet', block_index: 900123,
            block_hash: 'ab'.repeat(32), ledger_hash: 'cd'.repeat(32),
            actions_hash: 'ef'.repeat(32), contract_hash: '01'.repeat(32),
            checkpoint_seq: 417, snapshot_block: 900120,
            supersedes_from: 900000, rules_digest: RULES_DIGEST
        };
        const canonical = Checkpoint.canonicalCheckpoint(cp);
        assert.strictEqual(canonical.includes('SUPERSEDE'), false);
        cp.validator_signatures = [{ pubkey: key.pubkey, sig: sign(key.privateKey, canonical) }];
        assert.strictEqual(Checkpoint.verifyCheckpoint(cp, [key.pubkey]).valid, false);
    });
});
