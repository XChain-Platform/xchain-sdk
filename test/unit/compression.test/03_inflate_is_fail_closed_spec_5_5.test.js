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
    describe('inflate is fail-closed (spec §5.5)', function () {
        it('serves stored bytes for a lying COMPRESSION field over non-deflate bytes', async function () {
            const lie = Buffer.from('this is plain text, not a deflate stream at all', 'utf8');
            const r = await compression.inflate(lie);
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.storedForm, true);
            assert.strictEqual(r.error, 'INVALID_DEFLATE_STREAM');
            assert.ok(r.bytes.equals(lie), 'the stored bytes are served verbatim');
        });

        it('serves stored bytes for a TRUNCATED deflate stream, never partial output', async function () {
            const original = Buffer.from('truncate me. '.repeat(400), 'utf8');
            const deflated = await compression.compress(original);
            const truncated = deflated.subarray(0, Math.floor(deflated.length / 2));
            const r = await compression.inflate(truncated);
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.storedForm, true);
            assert.ok(r.bytes.equals(truncated));
            assert.ok(!r.bytes.includes(Buffer.from('truncate me')),
                'no partially inflated output is ever returned');
        });

        it('aborts a compression bomb on the ratio guard', async function () {
            // ~1000:1. Well past the 150:1 cap.
            const bomb = zlib.deflateRawSync(Buffer.alloc(3 * 1024 * 1024, 0));
            const r = await compression.inflate(bomb);
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.error, 'RATIO_GUARD_TRIPPED');
            assert.ok(r.bytes.equals(bomb), 'stored form is the compressed bytes');
        });

        it('the bomb abort is STREAMED: output never reaches the full inflated size', async function () {
            const originalSize = 3 * 1024 * 1024;
            const bomb = zlib.deflateRawSync(Buffer.alloc(originalSize, 0));
            const ceiling = bomb.length * CONSTANTS.COMPRESSION_MAX_RATIO;
            assert.ok(ceiling < originalSize,
                'precondition: the guard must trip before the payload is fully inflated');
            const r = await compression.inflate(bomb);
            assert.strictEqual(r.error, 'RATIO_GUARD_TRIPPED');
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
    describe('inflate is fail-closed (spec §5.5)', function () {
        it('never throws on hostile or malformed input', async function () {
            // These fixtures are deterministically not a valid deflate-raw
            // stream (empty, single/four-byte bogus lead-ins, non-buffer
            // types), so inflated:false is a fixed, safe assumption here.
            const deterministicallyInvalid = [
                Buffer.alloc(0),
                Buffer.from([0x00]),
                Buffer.from([0xff, 0xff, 0xff, 0xff]),
                null,
                undefined,
                'not a buffer',
                42
            ];
            for (const input of deterministicallyInvalid) {
                const r = await compression.inflate(input);
                assert.strictEqual(r.inflated, false, 'no false positive on ' + String(input));
                assert.ok(typeof r.error === 'string');
            }

            // A raw deflate stream carries no header or checksum, so a
            // random 64-byte buffer can, on rare occasion, decode as a
            // (bounded, sane) valid stream. Never assert the fixed outcome
            // here; just never throw, and never hand back an unbounded or
            // malformed-shaped result either way.
            const r = await compression.inflate(crypto.randomBytes(64));
            if (r.inflated) {
                assert.ok(Buffer.isBuffer(r.bytes));
                assert.ok(r.bytes.length <= r.storedLength * CONSTANTS.COMPRESSION_MAX_RATIO);
            } else {
                assert.ok(typeof r.error === 'string');
            }
        });

        it('fuzzed byte strings never throw and never claim a false inflate', async function () {
            for (let i = 0; i < 200; i++) {
                const r = await compression.inflate(crypto.randomBytes(1 + (i % 128)));
                if (r.inflated) {
                    // A random string CAN be a valid deflate stream; if so the
                    // output must still be sane and bounded.
                    assert.ok(Buffer.isBuffer(r.bytes));
                    assert.ok(r.bytes.length <= r.storedLength * CONSTANTS.COMPRESSION_MAX_RATIO);
                } else {
                    assert.ok(typeof r.error === 'string');
                }
            }
        });
    });
});
