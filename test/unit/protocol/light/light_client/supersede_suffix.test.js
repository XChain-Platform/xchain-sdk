/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Light-client checkpoint supersession suffix byte coverage.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { canonicalCheckpoint } = require('../../../../../src/checkpoint.js');
const {
    hasSupersedeFields,
    supersedeSuffix
} = require('../../../../../src/protocol/light_client/supersede_suffix.js');

const DIGEST = 'CD'.repeat(32);

describe('light-client supersede suffix @regression @tier1', function () {
    it('detects either non-null supersession field', function () {
        assert.strictEqual(hasSupersedeFields({}), false);
        assert.strictEqual(hasSupersedeFields({ supersedes_from: null, rules_digest: null }), false);
        assert.strictEqual(hasSupersedeFields({ supersedes_from: 0 }), true);
        assert.strictEqual(hasSupersedeFields({ rules_digest: DIGEST }), true);
    });

    it('returns an empty suffix for a plain checkpoint', function () {
        assert.strictEqual(supersedeSuffix({ block_index: 5 }), '');
        assert.strictEqual(supersedeSuffix({ supersedes_from: null, rules_digest: null }), '');
    });

    it('serializes the exact SUPERSEDE bytes and normalizes field representations', function () {
        assert.strictEqual(
            supersedeSuffix({ supersedes_from: '12', rules_digest: DIGEST }),
            '|SUPERSEDE|12|' + DIGEST.toLowerCase()
        );
    });

    it('throws when supersedes_from is missing', function () {
        assert.throws(() => supersedeSuffix({ rules_digest: DIGEST }), /requires supersedes_from and rules_digest/);
    });

    it('throws when rules_digest is missing', function () {
        assert.throws(() => supersedeSuffix({ supersedes_from: 3 }), /requires supersedes_from and rules_digest/);
    });

    it('throws when supersedes_from is not a non-negative safe integer', function () {
        assert.throws(() => supersedeSuffix({ supersedes_from: 1.5, rules_digest: DIGEST }), /non-negative safe integer/);
        assert.throws(() => supersedeSuffix({ supersedes_from: -1, rules_digest: DIGEST }), /non-negative safe integer/);
        assert.throws(() => supersedeSuffix({ supersedes_from: Number.MAX_SAFE_INTEGER + 1, rules_digest: DIGEST }), /non-negative safe integer/);
    });

    it('throws when rules_digest is not 64 hexadecimal characters', function () {
        assert.throws(() => supersedeSuffix({ supersedes_from: 1, rules_digest: 'cd' }), /64 hexadecimal characters/);
        assert.throws(() => supersedeSuffix({ supersedes_from: 1, rules_digest: 'zz'.repeat(32) }), /64 hexadecimal characters/);
    });

    it('does not add SUPERSEDE text to a plain canonicalCheckpoint fixture', function () {
        const plain = {
            chain: 'BTC',
            network: 'mainnet',
            block_index: 900123,
            block_hash: 'ab'.repeat(32),
            ledger_hash: 'cd'.repeat(32),
            actions_hash: 'ef'.repeat(32),
            contract_hash: '01'.repeat(32),
            checkpoint_seq: 417,
            snapshot_block: 900120
        };

        assert.strictEqual(canonicalCheckpoint(plain).includes('SUPERSEDE'), false);
    });
});
