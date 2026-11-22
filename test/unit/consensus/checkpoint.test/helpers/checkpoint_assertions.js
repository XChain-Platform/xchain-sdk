// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const CHECKPOINT_VECTORS = require('../../../../fixtures/checkpoint_canonical_vectors.json');

function assertCheckpointVectors(canonicalCheckpoint) {
    for (const vector of CHECKPOINT_VECTORS.cases) {
        if (vector.throws)
            assert.throws(() => canonicalCheckpoint(vector.checkpoint), undefined, vector.name);
        else
            assert.strictEqual(canonicalCheckpoint(vector.checkpoint), vector.expected, vector.name);
    }
}

function rawCanonical(cp) {
    let raw = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
        cp.ledger_hash, cp.actions_hash, cp.contract_hash,
        String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    // The commitment suffix is part of the v0 raw that EQUIV wraps, and a regtest
    // fixture now carries roots because a rootless one cannot exist. Mirror the
    // production builder so this test still isolates the WRAPPING.
    if (cp.state_root !== undefined)
        raw += '|' + [String(cp.state_root).toLowerCase(), String(cp.state_root_version),
                      String(cp.block_merkle_root).toLowerCase(), String(cp.block_merkle_version)].join('|');
    return raw;
}

module.exports = { assertCheckpointVectors, rawCanonical };
