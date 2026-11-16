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
const { fileHashOf, planMultipartFile } = require('../../src/file/multipart.js');
const {
    MULTIPART_FILE_MAX_PARTS,
    MULTIPART_FILE_MAX_BYTES,
    FILE_MULTIPART_ACTIVATION_TIME,
} = require('../../src/protocol/constants.js');

function bytesOf(vector) {
    return vector.parts.map((part) => Buffer.from(part.hex, 'hex'));
}

function errorCode(promise, code) {
    return assert.rejects(promise, (error) => error && error.code === code);
}

function registerProtocolTests() {
    it('exports the protocol caps and activation map', function () {
        assert.strictEqual(MULTIPART_FILE_MAX_PARTS, 32);
        assert.strictEqual(MULTIPART_FILE_MAX_BYTES, 12000000);
        assert.deepStrictEqual(FILE_MULTIPART_ACTIVATION_TIME, {
            mainnet: null,
            testnet: 1796083200,
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
    it('allows stored gated bytes exactly at the indexer TOTAL_BYTES cap', async function () {
        const original = Buffer.alloc(MULTIPART_FILE_MAX_BYTES - 28);
        const plan = await planMultipartFile(original, {}, {
            carrier: 'TAPROOT',
            gate: { key: Buffer.alloc(32, 7) },
        });
        assert.strictEqual(plan.totalBytes, MULTIPART_FILE_MAX_BYTES);
        assert.strictEqual(plan.parts.length, 31);
    });

    it('refuses stored gated bytes one byte above the indexer TOTAL_BYTES cap', async function () {
        const original = Buffer.alloc(MULTIPART_FILE_MAX_BYTES - 27);
        await errorCode(planMultipartFile(original, {}, {
            carrier: 'TAPROOT',
            gate: { key: Buffer.alloc(32, 7) },
        }), 'STORED_BYTES_TOO_LARGE');
    });

    it('refuses original bytes above the original-byte cap before compression', async function () {
        await errorCode(
            planMultipartFile(Buffer.alloc(MULTIPART_FILE_MAX_BYTES + 1), {}, { carrier: 'TAPROOT' }),
            'ORIGINAL_BYTES_TOO_LARGE');
    });

    it('accepts 32 Standard parts and refuses 33', async function () {
        const valid = await planMultipartFile(Buffer.alloc(8114 * 32), {}, { carrier: 'P2SH' });
        assert.strictEqual(valid.parts.length, 32);
        await errorCode(
            planMultipartFile(Buffer.alloc(8114 * 32 + 1), {}, { carrier: 'P2SH' }),
            'TOO_MANY_PARTS');
    });
}

describe('multipart FILE planning', function () {
    registerProtocolTests();
    registerPlanningTests();
    registerLimitTests();
});
