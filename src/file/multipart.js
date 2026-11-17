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
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const CompressionUtils = require('../protocol/compression.js');
const GatedFileUtils = require('../actions/gated_file.js');
const {
    carrierCeiling,
    compiledPushSize,
    envelopePayloadSize,
} = require('../contract/chunk_helper.js');
const {
    MULTIPART_FILE_MAX_PARTS,
    MULTIPART_FILE_MAX_BYTES,
} = require('../protocol/constants.js');

const FILE_HASH_BYTES = 32;
const ENCRYPTION_METHOD_AES_256_GCM = 1;

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'utf8');
    throw new TypeError('bytes must be a Buffer, Uint8Array, or string');
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest();
}

function partBytes(part) {
    if (Buffer.isBuffer(part) || part instanceof Uint8Array || typeof part === 'string')
        return toBuffer(part);
    if (!part || typeof part !== 'object')
        throw new TypeError('each part must carry bytes');
    if (part.bytes !== undefined) return toBuffer(part.bytes);
    if (part.rawData !== undefined) return toBuffer(part.rawData);
    if (part.data !== undefined) return toBuffer(part.data);
    if (typeof part.hex === 'string') return Buffer.from(part.hex, 'hex');
    throw new TypeError('each part must carry bytes');
}

function fileHashOf(parts) {
    if (!Array.isArray(parts) || parts.length === 0)
        throw new TypeError('parts must be a non-empty array');
    const digests = parts.map((part) => sha256(partBytes(part)));
    return sha256(Buffer.concat(digests)).toString('hex');
}

function normalizedCarrier(carrier) {
    return String(carrier || 'TAPROOT').toUpperCase() === 'STANDARD' ? 'P2SH' : carrier || 'TAPROOT';
}

// The part header carries its index, so the room left for bytes shrinks by one
// byte for every digit the widest index adds.
function partCapacity(carrier, indexDigits = 2) {
    const action = 'FILE|2|' + '0'.repeat(FILE_HASH_BYTES * 2) + '|' + '9'.repeat(indexDigits);
    const actionLength = Buffer.byteLength(action, 'utf8');
    const ceiling = carrierCeiling(actionLength, normalizedCarrier(carrier));
    const available = ceiling.limit - compiledPushSize(actionLength);
    let capacity = available;
    while (envelopePayloadSize(capacity) > available) capacity--;
    return capacity;
}

function splitStoredBytes(stored, capacity) {
    const parts = [];
    for (let offset = 0; offset < stored.length; offset += capacity)
        parts.push(stored.subarray(offset, Math.min(offset + capacity, stored.length)));
    if (parts.length > 1 && parts[parts.length - 1].length === 1) {
        const previous = parts[parts.length - 2];
        parts[parts.length - 2] = previous.subarray(0, previous.length - 1);
        parts[parts.length - 1] = Buffer.concat([
            previous.subarray(previous.length - 1),
            parts[parts.length - 1],
        ]);
    }
    return parts.map((part) => Buffer.from(part));
}

function field(source, camel, wire, fallback = '') {
    if (source && source[camel] !== undefined && source[camel] !== null) return source[camel];
    if (source && source[wire] !== undefined && source[wire] !== null) return source[wire];
    return fallback;
}

function rangeError(code, message, details = {}) {
    const error = new RangeError(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function validateOriginalBytes(bytes) {
    const original = toBuffer(bytes);
    if (original.length === 0)
        throw rangeError('EMPTY_FILE', 'multipart files must contain at least one byte');
    return original;
}

function assertMultipartBounds({ originalBytes, storedBytes, totalParts, capacity }) {
    if (originalBytes > MULTIPART_FILE_MAX_BYTES)
        throw rangeError('ORIGINAL_BYTES_TOO_LARGE',
            `original bytes exceed MULTIPART_FILE_MAX_BYTES (${MULTIPART_FILE_MAX_BYTES})`,
            { originalBytes, maxBytes: MULTIPART_FILE_MAX_BYTES });
    if (storedBytes > MULTIPART_FILE_MAX_BYTES)
        throw rangeError('STORED_BYTES_TOO_LARGE',
            `stored bytes exceed MULTIPART_FILE_MAX_BYTES (${MULTIPART_FILE_MAX_BYTES})`,
            { storedBytes, maxBytes: MULTIPART_FILE_MAX_BYTES });
    if (totalParts > MULTIPART_FILE_MAX_PARTS)
        throw rangeError('TOO_MANY_PARTS',
            `stored bytes require ${totalParts} parts, exceeding MULTIPART_FILE_MAX_PARTS (${MULTIPART_FILE_MAX_PARTS})`,
            { totalParts, maxParts: MULTIPART_FILE_MAX_PARTS, capacity });
}

async function storeFileBytes(original, meta, gate) {
    const compression = new CompressionUtils();
    const compressed = await compression.compressIfSmaller(original, {
        maxInputBytes: MULTIPART_FILE_MAX_BYTES,
    });
    let stored = compressed.bytes;
    let key = null;
    let keyHash = '';
    let encryptionMethod = '';

    if (gate && gate.key !== undefined && gate.key !== null) {
        const gatedFile = new GatedFileUtils();
        key = gate.key;
        stored = gatedFile.encryptWithKey(stored, key);
        keyHash = crypto.createHash('sha256').update(key).digest('hex');
        encryptionMethod = field(gate, 'encryptionMethod', 'ENCRYPTION_METHOD',
            field(meta, 'encryptionMethod', 'ENCRYPTION_METHOD', ENCRYPTION_METHOD_AES_256_GCM));
    }
    return { compressed, stored, key, keyHash, encryptionMethod };
}

// A file of at most 100 parts keeps the two-digit sizing it was always planned
// with, so a resumed upload re-plans the same parts; a longer file is re-sized
// until its part count fits the index width the capacity assumed.
function splitForIndexWidth(stored, carrier) {
    let digits = 2;
    for (;;) {
        const capacity = partCapacity(carrier, digits);
        const buffers = splitStoredBytes(stored, capacity);
        const needed = Math.max(2, String(buffers.length - 1).length);
        if (needed <= digits) return { capacity, buffers };
        digits = needed;
    }
}

function buildParts(stored, carrier) {
    const { capacity, buffers } = splitForIndexWidth(stored, carrier);
    const fileHash = fileHashOf(buffers);
    const parts = buffers.map((part, partIndex) => ({
        partIndex,
        bytes: part,
        rawData: part,
        digest: sha256(part).toString('hex'),
        params: { version: 2, fileHash, partIndex },
    }));
    return { capacity, fileHash, parts };
}

function buildManifestParams(meta, gate, stored, compressed, encryptionMethod, keyHash, parts) {
    return {
        version: 1,
        fileHash: parts.fileHash,
        totalParts: parts.parts.length,
        totalBytes: stored.length,
        name: field(meta, 'name', 'NAME'),
        type: field(meta, 'type', 'TYPE'),
        title: field(meta, 'title', 'TITLE'),
        memo: field(meta, 'memo', 'MEMO'),
        gateTicker: field(meta, 'gateTicker', 'GATE_TICKER', field(gate, 'ticker', 'GATE_TICKER')),
        encryptionMethod,
        keyHash,
        gateMinAmount: field(meta, 'gateMinAmount', 'GATE_MIN_AMOUNT', field(gate, 'minAmount', 'GATE_MIN_AMOUNT')),
        compression: compressed.compressionField,
    };
}

async function planMultipartFile(bytes, meta = {}, options = {}) {
    const original = validateOriginalBytes(bytes);
    assertMultipartBounds({ originalBytes: original.length });
    const gate = options.gate || null;
    const storedFile = await storeFileBytes(original, meta, gate);
    const { compressed, stored, key, keyHash, encryptionMethod } = storedFile;
    assertMultipartBounds({ storedBytes: stored.length });
    const partPlan = buildParts(stored, options.carrier);
    const { capacity, fileHash, parts } = partPlan;
    assertMultipartBounds({
        totalParts: parts.length,
        capacity,
    });
    const manifestParams = buildManifestParams(
        meta, gate, stored, compressed, encryptionMethod, keyHash, partPlan);

    return {
        parts,
        fileHash,
        FILE_HASH: fileHash,
        totalBytes: stored.length,
        TOTAL_BYTES: stored.length,
        totalParts: parts.length,
        TOTAL_PARTS: parts.length,
        partCapacity: capacity,
        compression: compressed.compressionField,
        compressionField: compressed.compressionField,
        compressed: compressed.compressed,
        encryptionMethod,
        key,
        keyHash,
        storedBytes: Buffer.from(stored),
        manifestParams,
        manifest: { params: manifestParams },
    };
}

module.exports = {
    assertMultipartBounds,
    fileHashOf,
    planMultipartFile,
};
