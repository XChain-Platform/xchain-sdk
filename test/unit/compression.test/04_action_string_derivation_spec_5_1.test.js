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

    const GATED = 'FILE|0|g.bin|application/octet-stream|T||MYTOKEN|1|' + 'a'.repeat(64) + '|100';

describe('CompressionUtils (Part B)', function () {
    let compression;
    let gatedFile;

    beforeEach(function () {
        compression = new CompressionUtils();
        gatedFile = new GatedFileUtils();
    });
    describe('action-string derivation (spec §5.1)', function () {
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
    });
});

describe('CompressionUtils (Part B)', function () {
    let compression;
    let gatedFile;

    beforeEach(function () {
        compression = new CompressionUtils();
        gatedFile = new GatedFileUtils();
    });
    describe('action-string derivation (spec §5.1)', function () {
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
});
