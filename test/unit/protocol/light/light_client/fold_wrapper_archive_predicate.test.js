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
 **********************************************************************
 *
 * Fold-wrapper archive-set predicate and validator-cache partitioning.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const gateRegistry = require('../../../../../src/consensus/gate_registry.js');
const { usesArchiveSet, clearValidatorSetCache, explorerValidators } =
    require('../../../../../src/protocol/light_client/quorum_resolution.js');

function checkpoint(overrides = {}) {
    return Object.assign({
        network: 'regtest', snapshot_block: 0, block_index: 7,
        fold_archive: { match_batch_seq: 1 }
    }, overrides);
}

function countingFetch(bodies, calls) {
    return async (url) => {
        calls.push(url);
        const body = bodies[calls.length - 1];
        return { ok: true, status: 200, json: async () => body };
    };
}

describe('fold wrapper archive predicate @regression @tier1', function () {
    beforeEach(function () { clearValidatorSetCache(); });

    it('uses the archive set only for a fold wrapper above both gates', function () {
        assert.strictEqual(usesArchiveSet(checkpoint()), true);
        assert.strictEqual(usesArchiveSet(checkpoint({ fold_archive: null })), false);
        for (const snapshot_block of [0, 961000, Number.MAX_SAFE_INTEGER]) {
            assert.strictEqual(usesArchiveSet(checkpoint({ network: 'mainnet', snapshot_block })), false);
        }
        assert.strictEqual(usesArchiveSet(checkpoint({
            network: 'testnet', snapshot_block: gateRegistry.UNARMED - 1
        })), false);
    });

    it('reuses one cache entry for two plain checkpoints at one height', async function () {
        const calls = [];
        const validators = [{ pubkey: 'plain' }];
        const fetchImpl = countingFetch([{ validators }], calls);
        const plain = checkpoint({ fold_archive: null });

        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', plain), validators);
        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', Object.assign({}, plain)), validators);
        assert.strictEqual(calls.length, 1);
    });

    it('keeps folded and plain checkpoints at one height in separate cache entries', async function () {
        const calls = [];
        const foldedValidators = [{ pubkey: 'folded' }];
        const plainValidators = [{ pubkey: 'plain' }];
        const fetchImpl = countingFetch([
            { validators: foldedValidators },
            { validators: plainValidators }
        ], calls);
        const folded = checkpoint();
        const plain = checkpoint({ fold_archive: null });

        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', folded), foldedValidators);
        assert.deepStrictEqual(await explorerValidators(fetchImpl, 'https://x', 'RBTC', plain), plainValidators);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0], calls[1]);
    });
});
