// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const vectors = require('../fixtures/multipart_file.json').vectors;
const GatedFileUtils = require('../../src/actions/gated_file.js');
const CompressionUtils = require('../../src/protocol/compression.js');
const {
    assertMultipartBounds,
    fileHashOf,
    planMultipartFile,
} = require('../../src/file/multipart.js');
const {
    MULTIPART_FILE_MAX_PARTS,
    MULTIPART_FILE_MAX_BYTES,
    FILE_MULTIPART_ACTIVATION_TIME,
} = require('../../src/protocol/constants.js');

function bytesOf(vector) {
    return vector.parts.map((part) => Buffer.from(part.hex, 'hex'));
}

function registerProtocolTests() {
    it('exports the protocol caps and activation map', function () {
        assert.strictEqual(MULTIPART_FILE_MAX_PARTS, 65535);
        assert.strictEqual(MULTIPART_FILE_MAX_BYTES, 262140000000);
        assert.deepStrictEqual(FILE_MULTIPART_ACTIVATION_TIME, {
            mainnet: null,
            testnet: 1794787200,
            regtest: 0,
        });
    });

    it('reproduces every documentation vector digest and FILE_HASH', function () {
        for (const vector of vectors) {
            const parts = bytesOf(vector);
            parts.forEach((part, index) => {
                const digest = crypto.createHash('sha256').update(part).digest('hex');
                assert.strictEqual(digest, vector.parts[index].digest, vector.name);
            });
            const expected = vector.actual_file_hash || vector.FILE_HASH;
            assert.strictEqual(fileHashOf(parts), expected, vector.name);
        }
    });

    it('accepts fixture-shaped part objects', function () {
        assert.strictEqual(fileHashOf(vectors[0].parts), vectors[0].FILE_HASH);
    });

    it('uses the exact envelope and Standard part capacities', async function () {
        const envelope = await planMultipartFile(Buffer.alloc(389921), {}, { carrier: 'TAPROOT' });
        const standard = await planMultipartFile(Buffer.alloc(8115), {}, { carrier: 'STANDARD' });
        assert.strictEqual(envelope.partCapacity, 389920);
        assert.strictEqual(standard.partCapacity, 8114);
        assert.deepStrictEqual(envelope.parts.map((part) => part.bytes.length), [389919, 2]);
        assert.deepStrictEqual(standard.parts.map((part) => part.bytes.length), [8113, 2]);
    });
}

function registerPlanningTests() {
    it('plans 10,000,000 zero bytes as 26 equal-capacity envelope parts plus the last', async function () {
        const plan = await planMultipartFile(Buffer.alloc(10000000), {
            name: 'zeros.bin',
            type: 'application/octet-stream',
        }, { carrier: 'TAPROOT' });
        assert.strictEqual(plan.compressed, false);
        assert.strictEqual(plan.compression, '');
        assert.strictEqual(plan.parts.length, 26);
        assert.ok(plan.parts.slice(0, -1).every((part) => part.bytes.length === 389920));
        assert.strictEqual(plan.totalBytes, 10000000);
        assert.strictEqual(plan.manifestParams.fileHash, plan.fileHash);
        assert.strictEqual(plan.manifestParams.totalParts, 26);
        assert.strictEqual(plan.manifestParams.totalBytes, 10000000);
        assert.strictEqual(fileHashOf(plan.parts), plan.fileHash);
    });

    it('compresses before gated encryption and round-trips the original bytes', async function () {
        const blocks = [];
        for (let i = 0; i < 200; i++) {
            const block = crypto.randomBytes(2000);
            blocks.push(block, block);
        }
        const original = Buffer.concat(blocks);
        const key = crypto.randomBytes(32);
        const plan = await planMultipartFile(original, {
            name: 'gated.bin',
            type: 'application/octet-stream',
            gateTicker: 'GATE',
            gateMinAmount: 1,
        }, { carrier: 'TAPROOT', gate: { key } });
        assert.strictEqual(plan.compressed, true);
        assert.strictEqual(plan.compression, '1');
        assert.strictEqual(plan.parts.length, 2);
        assert.strictEqual(plan.manifestParams.encryptionMethod, 1);
        assert.strictEqual(plan.manifestParams.keyHash,
            crypto.createHash('sha256').update(key).digest('hex'));
        const decrypted = new GatedFileUtils().decryptFileBytes(plan.storedBytes, key);
        const inflated = await new CompressionUtils().inflate(decrypted);
        assert.strictEqual(inflated.inflated, true);
        assert.deepStrictEqual(inflated.bytes, original);
    });
}

function registerLimitTests() {
    it('checks multipart bounds using numbers without allocating cap-sized buffers', function () {
        assert.doesNotThrow(() => assertMultipartBounds({
            originalBytes: MULTIPART_FILE_MAX_BYTES,
            storedBytes: MULTIPART_FILE_MAX_BYTES,
            totalParts: MULTIPART_FILE_MAX_PARTS,
            capacity: 8114,
        }));
        assert.throws(() => assertMultipartBounds({
            originalBytes: MULTIPART_FILE_MAX_BYTES + 1,
        }), (error) => error && error.code === 'ORIGINAL_BYTES_TOO_LARGE');
        assert.throws(() => assertMultipartBounds({
            storedBytes: MULTIPART_FILE_MAX_BYTES + 1,
        }), (error) => error && error.code === 'STORED_BYTES_TOO_LARGE');
        assert.throws(() => assertMultipartBounds({
            totalParts: MULTIPART_FILE_MAX_PARTS + 1,
            capacity: 8114,
        }), (error) => error && error.code === 'TOO_MANY_PARTS');
    });

    it('plans a real 40-part Standard file', async function () {
        const plan = await planMultipartFile(Buffer.alloc(8114 * 40), {}, { carrier: 'STANDARD' });
        assert.strictEqual(plan.parts.length, 40);
    });
}

describe('multipart FILE planning', function () {
    registerProtocolTests();
    registerPlanningTests();
    registerLimitTests();
});
