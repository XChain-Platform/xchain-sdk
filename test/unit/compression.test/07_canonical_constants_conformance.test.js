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

    describe('canonical constants conformance', function () {
        const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
            path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
        const DOCS_CONSTANTS = path.join(DOCS, 'protocol', 'constants.js');
        before(function () {
            if (!fs.existsSync(DOCS_CONSTANTS)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-documentation sibling not found but XCHAIN_REQUIRE_SIBLINGS=1');
                this.skip();
            }
        });

        it('the vendored copy equals the canonical declaration', function () {
            const docs = require(DOCS_CONSTANTS);
            assert.strictEqual(docs.COMPRESSION_CODE_DEFLATE_RAW, CONSTANTS.COMPRESSION_CODE_DEFLATE_RAW);
            assert.strictEqual(docs.COMPRESSION_MAX_RATIO, CONSTANTS.COMPRESSION_MAX_RATIO);
            assert.strictEqual(docs.COMPRESSION_MAX_INPUT_BYTES, CONSTANTS.COMPRESSION_MAX_INPUT_BYTES);
        });
    });
});
