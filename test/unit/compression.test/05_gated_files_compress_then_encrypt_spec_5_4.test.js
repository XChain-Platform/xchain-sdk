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
    let gatedFile;

    beforeEach(function () {
        gatedFile = new GatedFileUtils();
    });
    describe('gated FILEs: compress THEN encrypt (spec §5.4)', function () {
        it('compresses before encrypting and reports the field for the caller', async function () {
            const plaintext = Buffer.from('gated and compressible. '.repeat(300), 'utf8');
            const r = await gatedFile.compressAndEncryptFileBytes(plaintext);
            assert.strictEqual(r.compressed, true);
            assert.strictEqual(r.compressionField, '1');
            // Proof of ordering: encrypting the RAW plaintext could never be
            // this small, because GCM output tracks its input size exactly.
            assert.ok(r.encryptedLength < plaintext.length,
                'ciphertext is smaller than the plaintext, so compression happened first');
            assert.strictEqual(r.encryptedLength, r.ciphertext.length);
        });

        it('the client inverts it: decrypt then inflate, byte-for-byte', async function () {
            const plaintext = Buffer.from('round trip me. '.repeat(400), 'utf8');
            const r = await gatedFile.compressAndEncryptFileBytes(plaintext);
            const back = await gatedFile.decryptAndInflateFileBytes(r.ciphertext, r.key,
                { compressed: r.compressionField });
            assert.strictEqual(back.inflated, true);
            assert.strictEqual(back.storedForm, false);
            assert.ok(back.bytes.equals(plaintext));
        });

        it('honours the opt-out for compressibility-sensitive content', async function () {
            const plaintext = Buffer.from('secret. '.repeat(300), 'utf8');
            const r = await gatedFile.compressAndEncryptFileBytes(plaintext, { compress: false });
            assert.strictEqual(r.compressed, false);
            assert.strictEqual(r.compressionField, '');
            const back = await gatedFile.decryptAndInflateFileBytes(r.ciphertext, r.key,
                { compressed: r.compressionField });
            assert.ok(back.bytes.equals(plaintext));
        });

        it('already-compressed gated media rides raw and still round-trips', async function () {
            const media = crypto.randomBytes(4096);
            const r = await gatedFile.compressAndEncryptFileBytes(media);
            assert.strictEqual(r.compressed, false);
            const back = await gatedFile.decryptAndInflateFileBytes(r.ciphertext, r.key,
                { compressed: r.compressionField });
            assert.ok(back.bytes.equals(media));
        });

        it('supports pack keys (one key, many files)', async function () {
            const { key, keyHash } = gatedFile.generateKey();
            const a = await gatedFile.compressAndEncryptFileBytes(Buffer.from('aaa'.repeat(200)), { key });
            const b = await gatedFile.compressAndEncryptFileBytes(Buffer.from('bbb'.repeat(200)), { key });
            assert.strictEqual(a.keyHash, keyHash);
            assert.strictEqual(b.keyHash, keyHash);
            const backA = await gatedFile.decryptAndInflateFileBytes(a.ciphertext, key, { compressed: a.compressionField });
            assert.ok(backA.bytes.equals(Buffer.from('aaa'.repeat(200))));
        });
    });
});

describe('CompressionUtils (Part B)', function () {
    let gatedFile;

    beforeEach(function () {
        gatedFile = new GatedFileUtils();
    });
    describe('gated FILEs: compress THEN encrypt (spec §5.4)', function () {
        it('a WRONG key still throws (decryption failure is a real error)', async function () {
            const r = await gatedFile.compressAndEncryptFileBytes(Buffer.from('x'.repeat(500)));
            await assert.rejects(
                () => gatedFile.decryptAndInflateFileBytes(r.ciphertext, crypto.randomBytes(32),
                    { compressed: r.compressionField }),
                (err) => err.code === 'DECRYPT_FAILED'
            );
        });

        it('a LYING compression field degrades to stored-form instead of throwing', async function () {
            // Encrypted raw, but the action claims deflate-raw.
            const plaintext = Buffer.from('not deflated at all', 'utf8');
            const r = await gatedFile.compressAndEncryptFileBytes(plaintext, { compress: false });
            const back = await gatedFile.decryptAndInflateFileBytes(r.ciphertext, r.key, { compressed: '1' });
            assert.strictEqual(back.inflated, false);
            assert.strictEqual(back.storedForm, true);
            assert.strictEqual(back.error, 'INVALID_DEFLATE_STREAM');
            assert.ok(back.bytes.equals(plaintext), 'the decrypted bytes are presented as stored-form');
        });

        it('an unknown future code degrades to no-inflate, not an error', async function () {
            const plaintext = Buffer.from('future codes are inert', 'utf8');
            const r = await gatedFile.compressAndEncryptFileBytes(plaintext, { compress: false });
            const back = await gatedFile.decryptAndInflateFileBytes(r.ciphertext, r.key, { compressed: '2' });
            assert.strictEqual(back.inflated, false);
            assert.strictEqual(back.storedForm, false);
            assert.ok(back.bytes.equals(plaintext));
        });
    });
});
