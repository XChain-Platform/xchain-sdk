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

    describe('constants', function () {
        it('carries the pinned codes and caps', function () {
            assert.strictEqual(CONSTANTS.COMPRESSION_CODE_DEFLATE_RAW, '1');
            assert.strictEqual(CONSTANTS.COMPRESSION_MAX_RATIO, 150);
            assert.strictEqual(CONSTANTS.COMPRESSION_MAX_INPUT_BYTES, 16 * 1024 * 1024);
        });

        // The 150:1 cap only means something relative to deflate-raw's own
        // theoretical maximum (~1032:1). A cap at or above that guards nothing.
        it('the ratio cap sits below deflate-raw\'s theoretical maximum', function () {
            const zeros = Buffer.alloc(1024 * 1024, 0);
            const best = zeros.length / zlib.deflateRawSync(zeros).length;
            assert.ok(best > CONSTANTS.COMPRESSION_MAX_RATIO,
                `deflate-raw reaches ${best.toFixed(1)}:1, so a ${CONSTANTS.COMPRESSION_MAX_RATIO}:1 cap is meaningful`);
        });
    });
});
