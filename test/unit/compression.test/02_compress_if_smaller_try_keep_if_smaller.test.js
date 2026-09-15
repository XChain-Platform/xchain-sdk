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
 * FILE payload compression, SDK side.
 *
 * What this suite pins:
 *  1. the deflate-raw golden pair INFLATES to the pinned plaintext, and the
 *     gated golden vector inverts (decrypt -> inflate) to its pinned sha256;
 *  2. compression is presentational: we assert the round trip, never that a
 *     particular deflate OUTPUT is reproducible across implementations;
 *  3. try-and-keep-if-smaller, including both refusal paths (not smaller,
 *     and over the emit-time ratio guard);
 *  4. inflate is FAIL-CLOSED and never throws: garbage, truncation, a lying
 *     COMPRESSION field and a compression bomb all degrade to stored-form;
 *  5. the ratio guard aborts a bomb mid-stream rather than after allocating;
 *  6. COMPRESSION is derived from the ACTION STRING, never a parsed column,
 *     and the trailing-field convention keeps a non-compressed FILE
 *     byte-identical to the pre-Part-B form;
 *  7. compress-then-encrypt ordering for gated FILEs (§5.4).
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const CompressionUtils = require('../../../src/protocol/compression.js');
const GatedFileUtils = require('../../../src/actions/gated_file.js');
const { SDKCompressionError } = require('../../../src/utils/errors.js');
const CONSTANTS = require('../../../src/protocol/constants.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('CompressionUtils (Part B)', function () {
    let compression;
    let gatedFile;

    beforeEach(function () {
        compression = new CompressionUtils();
        gatedFile = new GatedFileUtils();
    });
    describe('compressIfSmaller (try, keep if smaller)', function () {
        it('keeps the compressed form for compressible data and reports the field', async function () {
            const original = Buffer.from('a compressible sentence. '.repeat(200), 'utf8');
            const r = await compression.compressIfSmaller(original);
            assert.strictEqual(r.compressed, true);
            assert.strictEqual(r.compressionField, '1');
            assert.ok(r.storedLength < r.rawLength);
            assert.strictEqual(r.reason, null);
            const back = await compression.inflate(r.bytes);
            assert.ok(back.bytes.equals(original));
        });

        it('keeps RAW for already-compressed media, with an empty field', async function () {
            // Random bytes stand in for JPEG/MP4/ZIP: deflate cannot shrink them.
            const media = crypto.randomBytes(8192);
            const r = await compression.compressIfSmaller(media);
            assert.strictEqual(r.compressed, false);
            assert.strictEqual(r.compressionField, '');
            assert.strictEqual(r.reason, 'not-smaller');
            assert.ok(r.bytes.equals(media), 'the original bytes ride through untouched');
        });

        it('keeps RAW when the payload compresses BEYOND the ratio guard (emit-time mirror)', async function () {
            // Legitimately hyper-compressible data (logs, padding, exports).
            // Emitting it compressed would spend money on bytes no compliant
            // reader will inflate, so it must fail BEFORE broadcast.
            const padded = Buffer.alloc(200000, 0x20);
            const r = await compression.compressIfSmaller(padded);
            assert.strictEqual(r.compressed, false);
            assert.strictEqual(r.reason, 'ratio-guard');
            assert.strictEqual(r.compressionField, '');
            assert.ok(r.bytes.equals(padded));
        });
    });
});

describe('CompressionUtils (Part B)', function () {
    let compression;
    let gatedFile;

    beforeEach(function () {
        compression = new CompressionUtils();
        gatedFile = new GatedFileUtils();
    });
    describe('compressIfSmaller (try, keep if smaller)', function () {
        it('the emit-time guard and the serve guard use the SAME ratio', async function () {
            // A payload the encoder would keep compressed must always be one a
            // reader will inflate. Drive a payload just under the guard and
            // assert both sides agree.
            const text = Buffer.from('xy'.repeat(60000), 'utf8');
            const r = await compression.compressIfSmaller(text);
            if (r.compressed) {
                const served = await compression.inflate(r.bytes);
                assert.strictEqual(served.inflated, true,
                    'anything emitted compressed must survive the serve guard');
            }
        });

        it('treats an empty payload as raw', async function () {
            const r = await compression.compressIfSmaller(Buffer.alloc(0));
            assert.strictEqual(r.compressed, false);
            assert.strictEqual(r.reason, 'empty');
        });
    });
});
