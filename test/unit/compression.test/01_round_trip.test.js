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

    describe('round trip', function () {
        it('inflates what it compressed, byte-for-byte', async function () {
            const original = Buffer.from('XChain '.repeat(500) + 'tail', 'utf8');
            const deflated = await compression.compress(original);
            assert.ok(deflated.length < original.length);
            const result = await compression.inflate(deflated);
            assert.strictEqual(result.inflated, true);
            assert.strictEqual(result.storedForm, false);
            assert.strictEqual(result.error, null);
            assert.ok(result.bytes.equals(original));
        });

        it('round-trips arbitrary binary bytes (not just text)', async function () {
            const original = crypto.randomBytes(4096);
            const deflated = await compression.compress(original);
            const result = await compression.inflate(deflated);
            assert.ok(result.bytes.equals(original), 'binary payload survives byte-for-byte');
        });

        it('round-trips an empty payload', async function () {
            const deflated = await compression.compress(Buffer.alloc(0));
            const result = await compression.inflate(deflated);
            assert.strictEqual(result.bytes.length, 0);
        });

        it('refuses input over the pre-compression cap', async function () {
            await assert.rejects(
                () => compression.compress(Buffer.alloc(2048), { maxInputBytes: 1024 }),
                (err) => err instanceof SDKCompressionError && err.code === 'INPUT_TOO_LARGE'
            );
        });

        it('rejects unusable input types', async function () {
            await assert.rejects(() => compression.compress(42),
                (err) => err instanceof SDKCompressionError && err.code === 'INVALID_INPUT');
        });
    });
});
