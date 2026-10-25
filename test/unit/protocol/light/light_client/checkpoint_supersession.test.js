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
 * Checkpoint supersession normalization and refusal unit coverage.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    CHECKPOINT_SUPERSEDED,
    supersessionFields,
    refuseSuperseded
} = require('../../../../../src/protocol/light_client/checkpoint_supersession.js');

describe('checkpoint supersession @regression @tier1', function () {
    it('exports the stable refusal reason', function () {
        assert.strictEqual(CHECKPOINT_SUPERSEDED, 'CHECKPOINT_SUPERSEDED');
    });

    it('normalizes string fields from explorer JSON without mutating the row', function () {
        const digest = 'Bc'.repeat(32);
        const row = {
            supersedes_from: '8',
            rules_digest: digest,
            superseded_by_seq: '12'
        };

        assert.deepStrictEqual(supersessionFields(row), {
            supersedes_from: 8,
            rules_digest: digest.toLowerCase(),
            superseded_by_seq: 12
        });
        assert.deepStrictEqual(row, {
            supersedes_from: '8',
            rules_digest: digest,
            superseded_by_seq: '12'
        });
    });

    it('maps absent and null supersession fields to null', function () {
        assert.deepStrictEqual(supersessionFields({}), {
            supersedes_from: null,
            rules_digest: null,
            superseded_by_seq: null
        });
        assert.deepStrictEqual(supersessionFields({
            supersedes_from: null,
            rules_digest: null,
            superseded_by_seq: null
        }), {
            supersedes_from: null,
            rules_digest: null,
            superseded_by_seq: null
        });
    });

    it('refuses a superseded row when opts is missing without mutating it', function () {
        const row = { superseded_by_seq: '12' };

        assert.deepStrictEqual(refuseSuperseded(row), {
            verified: false,
            reason: CHECKPOINT_SUPERSEDED,
            superseded_by_seq: 12
        });
        assert.deepStrictEqual(row, { superseded_by_seq: '12' });
    });

    it('allows superseded rows only when requested and accepts current rows', function () {
        assert.strictEqual(refuseSuperseded({ superseded_by_seq: '12' }, { allowSuperseded: true }), null);
        assert.strictEqual(refuseSuperseded({}, {}), null);
        assert.strictEqual(refuseSuperseded({ superseded_by_seq: null }), null);
    });
});
