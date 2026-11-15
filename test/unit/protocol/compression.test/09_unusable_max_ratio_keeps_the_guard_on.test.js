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
 * FILE payload compression, SDK side: an unusable maxRatio option (NaN, a non-numeric string, null, an object)
 * must never switch the ratio guard off: inflate still aborts a bomb, and
 * compressIfSmaller still refuses to emit bytes a compliant reader would not
 * inflate.
 */

'use strict';

const assert = require('assert');
const zlib = require('zlib');

const CompressionUtils = require('../../../../src/protocol/compression.js');

const label = (v) => (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) : `${typeof v} ${String(v)}`);

describe('CompressionUtils unusable maxRatio keeps the guard on', function () {
    const compression = new CompressionUtils();
    const bomb = zlib.deflateRawSync(Buffer.alloc(3 * 1024 * 1024, 0));
    const unusable = [NaN, 'abc', '', {}, [], undefined, null];

    for (const value of unusable) {
        it(`inflate trips the ratio guard with maxRatio ${label(value)}`, async function () {
            const r = await compression.inflate(bomb, { maxRatio: value });
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.storedForm, true);
            assert.strictEqual(r.error, 'RATIO_GUARD_TRIPPED');
        });

        it(`compressIfSmaller refuses an over-ratio payload with maxRatio ${label(value)}`, async function () {
            const r = await compression.compressIfSmaller(Buffer.alloc(3 * 1024 * 1024, 0), { maxRatio: value });
            assert.strictEqual(r.compressed, false);
            assert.strictEqual(r.reason, 'ratio-guard');
        });
    }

    it('still honours a usable numeric override and a numeric string', async function () {
        const small = zlib.deflateRawSync(Buffer.alloc(1000, 7));
        const ok = await compression.inflate(small, { maxRatio: 1000 });
        assert.strictEqual(ok.inflated, true);
        const okStr = await compression.inflate(small, { maxRatio: '1000' });
        assert.strictEqual(okStr.inflated, true);
        const tight = await compression.inflate(small, { maxRatio: 2 });
        assert.strictEqual(tight.error, 'RATIO_GUARD_TRIPPED');
    });
});
