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
 * FILE payload compression, SDK side: a non-finite maxRatio option (Infinity,
 * a string that parses to Infinity, an overflowing numeric string) must fall
 * back to the canonical ratio guard instead of making every ceiling comparison
 * false.
 */

'use strict';

const assert = require('assert');
const zlib = require('zlib');

const CompressionUtils = require('../../../../src/protocol/compression.js');

describe('CompressionUtils non-finite maxRatio keeps the guard on', function () {
    const compression = new CompressionUtils();
    const bomb = zlib.deflateRawSync(Buffer.alloc(3 * 1024 * 1024, 0));
    const nonFinite = [Infinity, -Infinity, 'Infinity', '-Infinity', '1e999'];

    for (const value of nonFinite) {
        it(`inflate trips the ratio guard with maxRatio ${typeof value} ${String(value)}`, async function () {
            const r = await compression.inflate(bomb, { maxRatio: value });
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.error, 'RATIO_GUARD_TRIPPED');
        });

        it(`compressIfSmaller refuses an over-ratio payload with maxRatio ${typeof value} ${String(value)}`, async function () {
            const r = await compression.compressIfSmaller(Buffer.alloc(3 * 1024 * 1024, 0), { maxRatio: value });
            assert.strictEqual(r.compressed, false);
            assert.strictEqual(r.reason, 'ratio-guard');
        });
    }

    it('keeps a large finite override usable', async function () {
        const small = zlib.deflateRawSync(Buffer.alloc(1000, 7));
        const ok = await compression.inflate(small, { maxRatio: 1e6 });
        assert.strictEqual(ok.inflated, true);
    });
});
