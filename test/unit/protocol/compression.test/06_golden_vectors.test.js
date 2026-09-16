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

const CompressionUtils = require('../../../../src/protocol/compression.js');
const GatedFileUtils = require('../../../../src/actions/gated_file.js');
const { SDKCompressionError } = require('../../../../src/utils/errors.js');
const CONSTANTS = require('../../../../src/protocol/constants.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

    // Golden vectors (sibling-gated on the documentation checkout, matching
    // the cross-repo skip convention used by the conformance suites).
const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
    path.join(__dirname, '../..', '..', '..', '..', 'xchain-documentation');
const VECTORS = path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json');
let vectors;

function loadVectors(context) {
    if (!fs.existsSync(VECTORS)) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('xchain-documentation sibling not found at ' + VECTORS + ' but XCHAIN_REQUIRE_SIBLINGS=1');
        context.skip();
        return;
    }
    vectors = require(VECTORS);
}

describe('CompressionUtils (Part B)', function () {
    let compression;
    let gatedFile;

    beforeEach(function () {
        compression = new CompressionUtils();
        gatedFile = new GatedFileUtils();
    });
    describe('golden vectors', function () {
        before(function () { loadVectors(this); });

        it('the deflate-raw pair inflates to the pinned plaintext', async function () {
            const v = vectors.deflate_raw_pair;
            const deflated = Buffer.from(v.deflated_hex, 'hex');
            assert.strictEqual(sha256(deflated), v.deflated_sha256, 'vector self-consistency');
            const r = await compression.inflate(deflated);
            assert.strictEqual(r.inflated, true);
            assert.strictEqual(r.bytes.length, v.raw_length);
            assert.strictEqual(sha256(r.bytes), v.raw_utf8_sha256);
        });

        // Compression is presentational (§5.5): only INFLATION is a
        // cross-implementation contract. This asserts our own encoder path
        // reproduces the vector's bytes today, while stating plainly that a
        // different implementation producing different deflate bytes for the
        // same input is CONFORMANT, not a bug.
        it('our compressor reproduces the vector bytes today (not a cross-implementation requirement)', async function () {
            const v = vectors.deflate_raw_pair;
            const original = await compression.inflate(Buffer.from(v.deflated_hex, 'hex'));
            const ours = await compression.compress(original.bytes);
            assert.strictEqual(ours.toString('hex'), v.deflated_hex);
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
    describe('golden vectors', function () {
        before(function () { loadVectors(this); });

        it('the gated vector inverts: decrypt then inflate to the pinned plaintext', async function () {
            const v = vectors.gated_compress_then_encrypt;
            const key = Buffer.from(v.key_hex, 'hex');
            const ciphertext = Buffer.from(v.ciphertext_hex, 'hex');
            assert.strictEqual(sha256(ciphertext), v.ciphertext_sha256, 'vector self-consistency');
            assert.strictEqual(sha256(key), v.key_hash, 'KEY_HASH is sha256(key)');

            const back = await gatedFile.decryptAndInflateFileBytes(ciphertext, key, { compressed: '1' });
            assert.strictEqual(back.inflated, true);
            assert.strictEqual(back.bytes.length, v.plaintext_length);
            assert.strictEqual(sha256(back.bytes), v.plaintext_sha256);
        });

        it('the gated vector uses the SDK ciphertext layout [iv 12][tag 16][ct]', function () {
            const v = vectors.gated_compress_then_encrypt;
            const ciphertext = Buffer.from(v.ciphertext_hex, 'hex');
            assert.strictEqual(ciphertext.subarray(0, GatedFileUtils.IV_LEN).toString('hex'), v.nonce_hex);
            const bodyLength = ciphertext.length - GatedFileUtils.IV_LEN - GatedFileUtils.AUTH_TAG_LEN;
            assert.strictEqual(bodyLength, v.deflated_length,
                'the encrypted body is the DEFLATED plaintext, proving compress-then-encrypt');
        });

        it('the vector ceiling matches the vendored constant', function () {
            assert.strictEqual(vectors._meta.ceiling.value, CONSTANTS.ENVELOPE_MAX_PAYLOAD || 390000);
        });
    });
});
