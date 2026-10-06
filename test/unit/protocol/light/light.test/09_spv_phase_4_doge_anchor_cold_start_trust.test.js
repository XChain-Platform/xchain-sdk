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
 **********************************************************************
 *
 * SPV light client (Phase 4) round-trip unit tests.
 *
 * Builds REAL balance + action proofs with the sdk merkle.js twin (the same
 * module the indexer commits with and the explorer serves with), then asserts:
 *   - the pure verifiers ACCEPT a valid proof (membership, non-inclusion, action),
 *   - they REJECT forged proofs (wrong amount, wrong key, swapped root, bad leaf),
 *   - the network verifyBalance path integrates quorum + binding end-to-end against
 *     a REAL Ed25519-signed checkpoint, with a mocked fetch (no server).
 *
 * Part file: the flag-day boundary case moved out of 04 so that file (and its
 * enclosing describe) stay under the size and function-line limits. Self-contained
 * like the other numbered files in this directory, with its own copy of the
 * fixtures the moved case needs.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const light  = require('../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../src/checkpoint.js');

const CHAIN = 'BTC', NET = 'regtest';

function makeSigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkeyHex: spki.subarray(spki.length - 32).toString('hex') };
}

// One SIGNED v0 section (state_root threaded in so it can bind a balance proof),
// returned as the checkpoint object, the section's wire fragment, the explorer
// section row and the qualifying validator set. `network` is a parameter so the
// header-network rule can be exercised: the signature covers the canonical built
// with THIS network, and the wire fragment never carries it.
function makeSignedSection(opts) {
    opts = opts || {};
    const chain = opts.chain || CHAIN;
    const net   = opts.network || NET;
    const signer = makeSigner();
    const cp = {
        chain, network: net, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: (opts.seq != null ? opts.seq : 7), snapshot_block: 100,
        state_root: opts.stateRoot || ('d4'.repeat(32)), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: []
    };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    const sigs = [{ pubkey: signer.pubkeyHex, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }];
    cp.validator_signatures = sigs;
    const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
    return { cp, sigs, validators };
}

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyAnchoredCheckpoint REJECTS roots on a snapshot below the CHECKPOINT_COMMITMENT flag day', function () {
        // The append condition is the registry row read through activeAt (W5): a
        // mainnet snapshot_block one below the armed height keeps the roots out of
        // the signed canonical, so a rooted row there carries roots nobody signed,
        // whatever its version fields say. The registry's own row is the oracle.
        const registry = require('../../../../src/consensus/gate_registry');
        const armed = registry.get('checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION').mainnet;
        assert.ok(Number.isInteger(armed) && armed > 0, 'mainnet is armed to a concrete height');
        const { cp, validators } = makeSignedSection({ network: 'mainnet' });
        cp.snapshot_block = armed - 1;
        const below = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(below.verified, false);
        assert.strictEqual(below.reason, 'ROOTS_NOT_SIGNED');
        // At the armed height the same row passes the flag-day gate and fails
        // further down (the fixture signature was over snapshot_block 100).
        cp.snapshot_block = armed;
        const at = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.notStrictEqual(at.reason, 'ROOTS_NOT_SIGNED');
    });
});
