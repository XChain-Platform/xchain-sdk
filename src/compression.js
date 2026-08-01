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
 *
 * FILE payload compression ( spec Part B).
 *
 * Wire contract:
 *   FILE|0|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION
 * COMPRESSION empty/absent = raw (every historical FILE), '1' = deflate-raw.
 *
 * Three rules govern everything in this file, all from spec §5.5:
 *
 *  1. Compression is PRESENTATIONAL, never consensus. Only INFLATION has to
 *     be reproducible; which exact deflate bytes an encoder emits is not
 *     pinned (level, implementation and version may all differ). Never write
 *     a test that pins deflate OUTPUT bytes as a cross-implementation
 *     contract; pin the inflate round trip instead.
 *  2. Inflation is FAIL-CLOSED. COMPRESSION is sender-asserted and
 *     unverified, so a lying field is trivially craftable. On an invalid
 *     stream or a tripped guard the reader serves the STORED bytes with an
 *     explicit stored-form indicator. Partially inflated output is never
 *     returned, and a lying field never throws out of the read helpers.
 *  3. Inflation is STREAMED and ratio-bounded (COMPRESSION_MAX_RATIO), so a
 *     compression bomb aborts mid-stream instead of allocating its way to
 *     the ceiling.
 *
 * Ordering for token-gated FILEs is compress THEN encrypt (spec §5.4):
 * AES-256-GCM ciphertext is incompressible, so the reverse order saves
 * nothing. The client inverts: decrypt, then inflate. Serve layers MUST NOT
 * attempt to inflate ciphertext.
 *
 ********************************************************************/

const zlib = require('zlib');
const { SDKCompressionError } = require('./errors.js');
const {
    COMPRESSION_CODE_DEFLATE_RAW,
    COMPRESSION_MAX_RATIO,
    COMPRESSION_MAX_INPUT_BYTES
} = require('./protocol/constants.js');

class CompressionUtils {

    /**
     * Compress payload bytes with deflate-raw, asynchronously.
     *
     * Async by requirement, not preference: the encoder that consumes this is
     * a hard single-instance service ( lockfile guard), so a synchronous
     * deflate on the request path would block every other caller for the
     * duration. There is deliberately no *Sync sibling exported.
     *
     * @param {Buffer|Uint8Array|string} payload - bytes to compress.
     * @param {object} [options]
     * @param {number} [options.maxInputBytes] - pre-compression input cap.
     * @returns {Promise<Buffer>} deflate-raw bytes.
     * @throws SDKCompressionError on unusable input or an oversized payload.
     */
    async compress(payload, options = {}) {
        let input = toBuffer(payload, 'payload');
        let maxInputBytes = (options.maxInputBytes === undefined)
            ? COMPRESSION_MAX_INPUT_BYTES
            : options.maxInputBytes;

        if (input.length > maxInputBytes)
            throw new SDKCompressionError('INPUT_TOO_LARGE',
                `Payload of ${input.length} bytes exceeds the ${maxInputBytes}-byte compression input cap.`,
                { length: input.length, maxInputBytes });

        return await new Promise((resolve, reject) => {
            zlib.deflateRaw(input, (err, result) => {
                if (err) return reject(new SDKCompressionError('COMPRESS_FAILED',
                    'deflate-raw compression failed.', { cause: err.message }));
                resolve(result);
            });
        });
    }

    /**
     * Try to compress, and report whether the result is worth keeping.
     *
     * This is the "try, keep if smaller" decision of spec §5.2 expressed once,
     * so the encoder and any other composer apply the SAME rule. Two ways a
     * payload comes back uncompressed:
     *   - it did not get smaller (already-compressed media: JPEG, MP4, ZIP);
     *   - it compressed BEYOND the ratio guard, which a compliant reader would
     *     refuse to inflate (spec §5.2's emit-time guard mirror). Emitting it
     *     compressed would spend real money on bytes no reader will serve, so
     *     the honest outcome is to emit it raw.
     *
     * @param {Buffer|Uint8Array|string} payload
     * @param {object} [options]
     * @param {number} [options.maxRatio] - emit-time ratio guard.
     * @param {number} [options.maxInputBytes]
     * @returns {Promise<{bytes: Buffer, compressed: boolean, compressionField: string,
     *                    rawLength: number, storedLength: number, ratio: number,
     *                    reason: string|null}>}
     */
    async compressIfSmaller(payload, options = {}) {
        let input = toBuffer(payload, 'payload');
        let maxRatio = (options.maxRatio === undefined) ? COMPRESSION_MAX_RATIO : options.maxRatio;

        let raw = {
            bytes: input,
            compressed: false,
            compressionField: '',
            rawLength: input.length,
            storedLength: input.length,
            ratio: 1
        };

        // An empty payload has nothing to gain and would make the ratio
        // undefined (0-length output); short-circuit before touching zlib.
        if (input.length === 0)
            return { ...raw, reason: 'empty' };

        let deflated = await this.compress(input, options);
        if (deflated.length >= input.length)
            return { ...raw, reason: 'not-smaller' };

        let ratio = input.length / deflated.length;
        if (ratio > maxRatio)
            return { ...raw, reason: 'ratio-guard' };

        return {
            bytes: deflated,
            compressed: true,
            compressionField: COMPRESSION_CODE_DEFLATE_RAW,
            rawLength: input.length,
            storedLength: deflated.length,
            ratio,
            reason: null
        };
    }

    /**
     * Inflate stored bytes, streamed and ratio-bounded. FAIL-CLOSED: never
     * throws for bad input, never returns partial output.
     *
     * The ratio cap is enforced as a STREAMED ABORT rather than a check on the
     * finished buffer: checking afterwards would mean the bomb has already
     * been allocated, which is the whole thing the guard exists to prevent.
     *
     * @param {Buffer|Uint8Array} stored - the bytes as stored on chain.
     * @param {object} [options]
     * @param {number} [options.maxRatio]
     * @returns {Promise<{bytes: Buffer, inflated: boolean, storedForm: boolean,
     *                    error: string|null, storedLength: number, originalLength: number}>}
     *   On success: inflated bytes, inflated=true, storedForm=false.
     *   On any failure: the STORED bytes verbatim, inflated=false,
     *   storedForm=true, and a machine-readable `error` the caller surfaces.
     */
    async inflate(stored, options = {}) {
        let maxRatio = (options.maxRatio === undefined) ? COMPRESSION_MAX_RATIO : options.maxRatio;
        let input;
        try {
            input = toBuffer(stored, 'stored');
        } catch (e) {
            // Even unusable input degrades rather than throwing: callers on the
            // serve path must always end up with something to send.
            return storedForm(Buffer.alloc(0), 'INVALID_INPUT');
        }

        if (input.length === 0)
            return storedForm(input, 'EMPTY_STREAM');

        let ceiling = Math.max(1, Math.ceil(input.length * maxRatio));

        return await new Promise((resolve) => {
            let stream = zlib.createInflateRaw();
            let chunks = [];
            let total = 0;
            let settled = false;

            const finish = (result) => {
                if (settled) return;
                settled = true;
                // Release the partial output explicitly: on the abort path it
                // is exactly the memory the guard is defending.
                chunks = null;
                resolve(result);
            };

            stream.on('data', (chunk) => {
                total += chunk.length;
                if (total > ceiling) {
                    // Streamed abort: stop consuming the moment the guard trips,
                    // before the remaining output is ever materialized.
                    stream.destroy();
                    return finish(storedForm(input, 'RATIO_GUARD_TRIPPED'));
                }
                if (chunks) chunks.push(chunk);
            });

            stream.on('end', () => {
                if (settled) return;
                let bytes = Buffer.concat(chunks, total);
                finish({
                    bytes,
                    inflated: true,
                    storedForm: false,
                    error: null,
                    storedLength: input.length,
                    originalLength: bytes.length
                });
            });

            // Truncated, corrupt, or simply-not-deflate bytes (a lying
            // COMPRESSION field) land here.
            stream.on('error', () => finish(storedForm(input, 'INVALID_DEFLATE_STREAM')));

            stream.end(input);
        });
    }

    /**
     * Does this FILE action string declare deflate-raw compression?
     *
     * DERIVED FROM THE ACTION STRING, ALWAYS (spec §5.1). Shipped indexers drop
     * unknown trailing fields at parse, so a compressed FILE mined before an
     * indexer upgrades would be stored marker-less and served as deflated
     * garbage forever if a reader trusted a parsed-at-ingest column. The full
     * action string is preserved verbatim (decoder transactions.data), so
     * serve-time derivation is always possible. Never replace this with a
     * column read.
     *
     * Lenient by design: anything that is not exactly the known code reads as
     * raw. An unknown code is not an error and never affects validity.
     *
     * @param {string} actionString - the full pipe-delimited action string.
     * @returns {boolean}
     */
    isCompressedAction(actionString) {
        return this.compressionFieldOf(actionString) === COMPRESSION_CODE_DEFLATE_RAW;
    }

    /**
     * Read the raw COMPRESSION field from a FILE action string, or '' when the
     * action is not a FILE v0, is truncated, or omits the field.
     *
     * @param {string} actionString
     * @returns {string} the field verbatim (NOT normalized), or ''.
     */
    compressionFieldOf(actionString) {
        if (typeof actionString !== 'string' || actionString.length === 0) return '';
        let parts = actionString.split('|');
        // FILE|0|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION
        //  0    1   2    3     4     5       6            7            8            9             10
        if (parts.length <= COMPRESSION_FIELD_INDEX) return '';
        if (String(parts[0]).toUpperCase() !== 'FILE') return '';
        if (String(parts[1]) !== '0') return '';
        return String(parts[COMPRESSION_FIELD_INDEX]);
    }

    /**
     * Is this FILE action token-gated?
     *
     * Load-bearing for the encoder (spec §5.4): on a gated FILE, COMPRESSION=1
     * means "inflate AFTER decrypt", so transparent compression of the
     * already-encrypted bytes by a lower layer would make the field ambiguous
     * and readers would inflate ciphertext. A gated FILE's COMPRESSION field
     * belongs to whoever did the compress-then-encrypt, and nobody else may
     * set it.
     *
     * @param {string} actionString
     * @returns {boolean}
     */
    isGatedAction(actionString) {
        if (typeof actionString !== 'string' || actionString.length === 0) return false;
        let parts = actionString.split('|');
        if (parts.length <= GATE_TICKER_FIELD_INDEX) return false;
        if (String(parts[0]).toUpperCase() !== 'FILE') return false;
        if (String(parts[1]) !== '0') return false;
        return String(parts[GATE_TICKER_FIELD_INDEX]).length > 0;
    }

    /**
     * Return `actionString` with its COMPRESSION field set to `value`,
     * padding intermediate optional fields with empties as needed.
     *
     * Mirrors the encoder's trailing-field convention: setting the field to ''
     * strips it (and any now-trailing empties) so a non-compressed FILE stays
     * byte-identical to what the pre-Part-B encoder would have produced. That
     * byte-identity is what keeps historical replay clean.
     *
     * @param {string} actionString - a FILE v0 action string.
     * @param {string} value - '' (raw) or COMPRESSION_CODE_DEFLATE_RAW.
     * @returns {string}
     * @throws SDKCompressionError if the action is not a FILE v0.
     */
    withCompressionField(actionString, value) {
        if (typeof actionString !== 'string' || actionString.length === 0)
            throw new SDKCompressionError('INVALID_ACTION', 'Action string is required.');

        let parts = actionString.split('|');
        if (String(parts[0]).toUpperCase() !== 'FILE' || String(parts[1]) !== '0')
            throw new SDKCompressionError('NOT_A_FILE_ACTION',
                'COMPRESSION is a FILE v0 field; refusing to set it on another action.',
                { action: String(parts[0]) });

        while (parts.length <= COMPRESSION_FIELD_INDEX) parts.push('');
        parts[COMPRESSION_FIELD_INDEX] = String(value == null ? '' : value);

        // Trailing-empty strip, matching the SDK's own serializer.
        while (parts.length > 2 && parts[parts.length - 1] === '') parts.pop();
        return parts.join('|');
    }
}

// FILE v0 field indices in the FULL action string (ACTION token included).
const GATE_TICKER_FIELD_INDEX = 6;
const COMPRESSION_FIELD_INDEX = 10;

function toBuffer(value, label) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === 'string') return Buffer.from(value, 'binary');
    throw new SDKCompressionError('INVALID_INPUT',
        `${label} must be a Buffer, Uint8Array, or string.`);
}

function storedForm(input, error) {
    return {
        bytes: input,
        inflated: false,
        storedForm: true,
        error,
        storedLength: input.length,
        originalLength: input.length
    };
}

module.exports = CompressionUtils;
module.exports.COMPRESSION_CODE_DEFLATE_RAW = COMPRESSION_CODE_DEFLATE_RAW;
module.exports.COMPRESSION_MAX_RATIO = COMPRESSION_MAX_RATIO;
module.exports.COMPRESSION_MAX_INPUT_BYTES = COMPRESSION_MAX_INPUT_BYTES;
module.exports.GATE_TICKER_FIELD_INDEX = GATE_TICKER_FIELD_INDEX;
module.exports.COMPRESSION_FIELD_INDEX = COMPRESSION_FIELD_INDEX;
