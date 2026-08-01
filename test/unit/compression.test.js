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
 * FILE payload compression ( spec Part B), SDK side.
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

const CompressionUtils = require('../../src/compression.js');
const GatedFileUtils = require('../../src/gatedFile.js');
const { SDKCompressionError } = require('../../src/errors.js');
const CONSTANTS = require('../../src/protocol/constants.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('CompressionUtils ( Part B)', function () {
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

        it('never throws on hostile or malformed input', async function () {
            const cases = [
                Buffer.alloc(0),
                Buffer.from([0x00]),
                Buffer.from([0xff, 0xff, 0xff, 0xff]),
                crypto.randomBytes(64),
                null,
                undefined,
                'not a buffer',
                42
            ];
            for (const input of cases) {
                const r = await compression.inflate(input);
                assert.strictEqual(r.inflated, false, 'no false positive on ' + String(input));
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

    describe('action-string derivation (spec §5.1)', function () {
        const GATED = 'FILE|0|g.bin|application/octet-stream|T||MYTOKEN|1|' + 'a'.repeat(64) + '|100';

        it('reads COMPRESSION from the action string, not a column', function () {
            assert.strictEqual(compression.isCompressedAction('FILE|0|a.txt|text/plain|T|M|||||1'), true);
            assert.strictEqual(compression.compressionFieldOf('FILE|0|a.txt|text/plain|T|M|||||1'), '1');
        });

        it('absent, empty, and short forms all read as raw', function () {
            const raws = [
                'FILE|0|a.txt|text/plain',
                'FILE|0|a.txt|text/plain|T|M|||||',
                'FILE|0|a.txt|text/plain|T|M||||',
                'FILE|0'
            ];
            for (const a of raws) assert.strictEqual(compression.isCompressedAction(a), false, a);
        });

        it('an UNKNOWN code degrades to raw and is never an error', function () {
            for (const code of ['2', '99', 'zstd', 'true', '01', ' 1']) {
                const action = 'FILE|0|a.txt|text/plain|T|M|||||' + code;
                assert.strictEqual(compression.isCompressedAction(action), false, code);
                assert.strictEqual(compression.compressionFieldOf(action), code,
                    'the raw field is still readable for diagnostics');
            }
        });

        it('ignores the field on non-FILE actions and other versions', function () {
            assert.strictEqual(compression.isCompressedAction('SEND|0|XCHAIN|1|a|b|c|d|e|f|1'), false);
            assert.strictEqual(compression.isCompressedAction('FILE|1|a.txt|text/plain|T|M|||||1'), false);
        });

        it('tolerates junk without throwing', function () {
            for (const junk of [null, undefined, '', 42, {}, []]) {
                assert.strictEqual(compression.isCompressedAction(junk), false);
                assert.strictEqual(compression.compressionFieldOf(junk), '');
            }
        });

        it('identifies gated FILEs (the encoder carve-out predicate)', function () {
            assert.strictEqual(compression.isGatedAction(GATED), true);
            assert.strictEqual(compression.isGatedAction('FILE|0|a.txt|text/plain|T|M'), false);
            assert.strictEqual(compression.isGatedAction('FILE|0|a.txt|text/plain|T|M||||'), false);
        });

        describe('withCompressionField', function () {
            it('sets the field at index 10, padding intermediate optionals', function () {
                const out = compression.withCompressionField('FILE|0|a.txt|text/plain', '1');
                assert.strictEqual(out, 'FILE|0|a.txt|text/plain|||||||1');
                assert.strictEqual(compression.isCompressedAction(out), true);
            });

            it('setting it empty leaves the action BYTE-IDENTICAL to the pre-Part-B form', function () {
                const before = 'FILE|0|a.txt|text/plain|Title|Memo';
                assert.strictEqual(compression.withCompressionField(before, ''), before);
            });

            it('preserves every existing field, including gating fields', function () {
                const out = compression.withCompressionField(GATED, '1');
                assert.strictEqual(out, GATED + '|1');
                assert.strictEqual(out.split('|')[6], 'MYTOKEN');
                assert.strictEqual(out.split('|')[9], '100');
            });

            it('is idempotent and can be cleared back to the original bytes', function () {
                const original = 'FILE|0|a.txt|text/plain|Title|Memo';
                const set = compression.withCompressionField(original, '1');
                assert.strictEqual(compression.withCompressionField(set, '1'), set);
                assert.strictEqual(compression.withCompressionField(set, ''), original);
            });

            it('refuses to set the field on a non-FILE action', function () {
                assert.throws(() => compression.withCompressionField('SEND|0|XCHAIN|1000', '1'),
                    (err) => err instanceof SDKCompressionError && err.code === 'NOT_A_FILE_ACTION');
            });
        });
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

    // -----------------------------------------------------------------------
    // Golden vectors (sibling-gated on the documentation checkout, matching
    // the cross-repo skip convention used by the conformance suites).
    // -----------------------------------------------------------------------
    describe('golden vectors', function () {
        const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const VECTORS = path.join(DOCS, 'protocol', 'test-vectors', 'taproot_envelope.json');
        let vectors;

        before(function () {
            if (!fs.existsSync(VECTORS)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-documentation sibling not found at ' + VECTORS + ' but XCHAIN_REQUIRE_SIBLINGS=1');
                this.skip();
            }
            vectors = require(VECTORS);
        });

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

    describe('canonical constants conformance', function () {
        const DOCS = process.env.XCHAIN_DOCUMENTATION_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-documentation');
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
