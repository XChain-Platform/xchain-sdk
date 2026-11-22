// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The fold-archive suffix is written out by hand here: the shared checkpoint vectors
// carry no fold case, so this is the only pin on the SDK's suffix bytes below the
// EQUIV gate and for an upper-case batch CRC.

const assert = require('assert');
const checkpoint = require('../../../src/checkpoint.js');

function baseCp(network, snapshotBlock) {
    return {
        chain: 'BTC', network, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: 7, snapshot_block: snapshotBlock,
    };
}

function rawBase(network, snapshotBlock) {
    return ['XCHECKPOINT', 'BTC', network, '100', 'c0'.repeat(32), 'a1'.repeat(32), 'b2'.repeat(32),
        'c3'.repeat(32), '7', String(snapshotBlock)].join('|');
}

const FOLD = { match_batch_seq: 42, match_count: 17, batch_crc32: '9C4E1B22', total_chunks: 1 };
const SUFFIX = '|42|17|9c4e1b22|1';

describe('checkpoint canonical: fold_archive suffix', function () {
    it('appends the lower-cased batch suffix to the bare bytes below the EQUIV gate', function () {
        const cp = Object.assign(baseCp('mainnet', 100), { fold_archive: FOLD });
        assert.strictEqual(checkpoint.canonicalCheckpoint(cp), rawBase('mainnet', 100) + SUFFIX);
    });

    it('leaves a checkpoint without a fold archive on the bare bytes', function () {
        assert.strictEqual(checkpoint.canonicalCheckpoint(baseCp('mainnet', 100)), rawBase('mainnet', 100));
    });

    it('wraps the extended bytes with the batch sequence in the round id at the EQUIV gate', function () {
        const cp = Object.assign(baseCp('regtest', 100), { fold_archive: FOLD });
        const expected = 'EQUIV|XCHECKPOINT|BTC|regtest|100|7|42|0||' + rawBase('regtest', 100) + SUFFIX;
        assert.strictEqual(checkpoint.canonicalCheckpoint(cp), expected);
    });

    it('signs the same bytes whether the batch CRC arrives upper or lower case', function () {
        const lower = Object.assign(baseCp('regtest', 100), { fold_archive: Object.assign({}, FOLD, { batch_crc32: '9c4e1b22' }) });
        const upper = Object.assign(baseCp('regtest', 100), { fold_archive: FOLD });
        assert.strictEqual(checkpoint.canonicalCheckpoint(upper), checkpoint.canonicalCheckpoint(lower));
    });
});
