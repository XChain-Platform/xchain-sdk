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
 * XChain Platform SDK - Token-Gated File Utilities
 *
 * AES-256-GCM symmetric encryption for FILE v1 gated content,
 * key-handoff payload (de)serialization, and pack helpers.
 *
 * The handoff payload is a compact binary blob:
 *   [1 byte version=0x01] [32-byte K] [32-byte K] ...
 * Recipients hash each 32-byte candidate to identify which gated FILE
 * (by KEY_HASH) it unlocks; no KEY_HASH is sent on the wire. Pack
 * membership is implicit; files sharing one K share one entry.
 * See xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
 *
 ********************************************************************/

const crypto = require('crypto');
const { SDKGatedFileError } = require('./errors.js');

// AES-256-GCM layout per gated FILE rawData:
//   [iv (12 bytes)] [authTag (16 bytes)] [ciphertext]
// The authTag is placed immediately after the IV so the receiver can
// parse fixed-length headers before allocating the ciphertext buffer.
const KEY_LEN = 32;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const GCM_OVERHEAD = IV_LEN + AUTH_TAG_LEN;

// Key-handoff payload version byte. Bump if the binary layout ever changes.
const HANDOFF_VERSION = 0x01;


class GatedFileUtils {

    /**
     * Generate a fresh random 256-bit symmetric key.
     *
     * @returns {{ key: Buffer, keyHash: string }} key Buffer (32 bytes) and hex sha256(key).
     */
    generateKey() {
        let key = crypto.randomBytes(KEY_LEN);
        let keyHash = crypto.createHash('sha256').update(key).digest('hex');
        return { key, keyHash };
    }

    /**
     * Encrypt plaintext under an existing key with AES-256-GCM.
     * Used for pack composition where multiple files share one key.
     *
     * @param {Buffer|string} plaintext - File bytes to encrypt.
     * @param {Buffer} key - 32-byte symmetric key.
     * @returns {Buffer} ciphertext: [iv(12)][authTag(16)][encrypted bytes]
     */
    encryptWithKey(plaintext, key) {
        if (plaintext === undefined || plaintext === null)
            throw new SDKGatedFileError('INVALID_PLAINTEXT', 'Plaintext is required.');
        if (!Buffer.isBuffer(key) || key.length !== KEY_LEN)
            throw new SDKGatedFileError('INVALID_KEY', `Key must be a ${KEY_LEN}-byte Buffer.`);

        let plaintextBuf = Buffer.isBuffer(plaintext)
            ? plaintext
            : Buffer.from(plaintext, 'utf8');

        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
        let authTag = cipher.getAuthTag();

        return Buffer.concat([iv, authTag, encrypted]);
    }

    /**
     * Single-file convenience: generate a key + encrypt in one call.
     *
     * @param {Buffer|string} plaintext - File bytes to encrypt.
     * @returns {{ ciphertext: Buffer, key: Buffer, keyHash: string }}
     */
    encryptFileBytes(plaintext) {
        let { key, keyHash } = this.generateKey();
        let ciphertext = this.encryptWithKey(plaintext, key);
        return { ciphertext, key, keyHash };
    }

    /**
     * Pack convenience: generate one key, encrypt N plaintexts under it.
     * All returned ciphertexts share the same key + keyHash and unlock
     * together when a holder receives the key.
     *
     * @param {Array<Buffer|string>} plaintexts
     * @returns {{ ciphertexts: Buffer[], key: Buffer, keyHash: string }}
     */
    encryptPack(plaintexts) {
        if (!Array.isArray(plaintexts) || plaintexts.length === 0)
            throw new SDKGatedFileError('INVALID_PACK',
                'encryptPack requires a non-empty array of plaintexts.');

        let { key, keyHash } = this.generateKey();
        let ciphertexts = plaintexts.map((p) => this.encryptWithKey(p, key));
        return { ciphertexts, key, keyHash };
    }

    /**
     * Decrypt ciphertext produced by encryptWithKey / encryptFileBytes /
     * encryptPack with the symmetric key.
     *
     * @param {Buffer} ciphertext - [iv(12)][authTag(16)][encrypted]
     * @param {Buffer} key - 32-byte symmetric key.
     * @returns {Buffer} plaintext bytes.
     * @throws SDKGatedFileError on GCM auth failure (wrong key, tampered ciphertext).
     */
    decryptFileBytes(ciphertext, key) {
        if (!Buffer.isBuffer(ciphertext))
            throw new SDKGatedFileError('INVALID_CIPHERTEXT', 'Ciphertext must be a Buffer.');
        if (ciphertext.length < GCM_OVERHEAD)
            throw new SDKGatedFileError('INVALID_CIPHERTEXT',
                `Ciphertext too short (need at least ${GCM_OVERHEAD} bytes).`);
        if (!Buffer.isBuffer(key) || key.length !== KEY_LEN)
            throw new SDKGatedFileError('INVALID_KEY', `Key must be a ${KEY_LEN}-byte Buffer.`);

        let iv = ciphertext.slice(0, IV_LEN);
        let authTag = ciphertext.slice(IV_LEN, IV_LEN + AUTH_TAG_LEN);
        let encrypted = ciphertext.slice(IV_LEN + AUTH_TAG_LEN);

        let decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        try {
            return Buffer.concat([decipher.update(encrypted), decipher.final()]);
        } catch (e) {
            throw new SDKGatedFileError('DECRYPT_FAILED',
                'AES-256-GCM authentication failed: wrong key or tampered ciphertext.',
                { cause: e.message });
        }
    }

    /**
     * Verify that a symmetric key matches an expected KEY_HASH.
     * Wallets call this after receiving a key from an ECIES handoff,
     * before attempting to decrypt the ciphertext.
     *
     * @param {Buffer} key - 32-byte symmetric key.
     * @param {string} keyHash - hex sha256(key) from the FILE v1 action.
     * @returns {boolean}
     */
    verifyKey(key, keyHash) {
        if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) return false;
        if (typeof keyHash !== 'string') return false;
        let actual = crypto.createHash('sha256').update(key).digest('hex');
        return actual === keyHash.toLowerCase();
    }

    /**
     * Serialize one or more symmetric keys into the binary handoff
     * payload that gets ECIES-encrypted into a MESSAGE v2.
     *
     * Wire layout:
     *   [1 byte version=0x01] [32-byte K1] [32-byte K2] ...
     *
     * No KEY_HASH is sent; the recipient hashes each 32-byte candidate
     * to identify which gated FILE it unlocks. Pack support is implicit
     * (files sharing one K share one entry).
     *
     * @param {Buffer[] | Record<string, Buffer>} keys - Either an array
     *   of 32-byte key Buffers, or a `{ keyHash hex: Buffer }` map (the
     *   hash keys are sanity-checked against sha256(K) but not put on
     *   the wire).
     * @returns {Buffer} Binary payload ready for ECIES encryption.
     */
    serializeKeyPayload(keys) {
        let list;
        if (Array.isArray(keys)) {
            list = keys;
        } else if (keys && typeof keys === 'object') {
            list = [];
            for (let hash of Object.keys(keys)) {
                let k = keys[hash];
                if (!Buffer.isBuffer(k) || k.length !== KEY_LEN)
                    throw new SDKGatedFileError('INVALID_KEY',
                        `Key for ${hash} must be a ${KEY_LEN}-byte Buffer.`);
                if (!this.verifyKey(k, hash))
                    throw new SDKGatedFileError('INVALID_KEY',
                        `Key for ${hash} does not hash to that KEY_HASH.`);
                list.push(k);
            }
        } else {
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                'keys must be an array of Buffer or an object map of hash → Buffer.');
        }

        if (list.length === 0)
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                'At least one key is required.');
        for (let k of list) {
            if (!Buffer.isBuffer(k) || k.length !== KEY_LEN)
                throw new SDKGatedFileError('INVALID_KEY',
                    `Each key must be a ${KEY_LEN}-byte Buffer.`);
        }

        return Buffer.concat([Buffer.from([HANDOFF_VERSION]), ...list]);
    }

    /**
     * Parse and validate a binary handoff payload after the wallet has
     * ECIES-decrypted a key-handoff MESSAGE. Returns the candidate
     * keys as an array; the caller hashes each to match against the
     * KEY_HASH of the gated FILE it cares about.
     *
     * @param {Buffer | string} payload - Decrypted MESSAGE plaintext
     *   bytes. A hex string is accepted for convenience.
     * @returns {Buffer[]} Array of 32-byte symmetric keys.
     * @throws SDKGatedFileError if the payload is malformed or uses an
     *   unsupported version byte.
     */
    parseKeyPayload(payload) {
        let buf;
        if (Buffer.isBuffer(payload)) {
            buf = payload;
        } else if (typeof payload === 'string') {
            try { buf = Buffer.from(payload, 'hex'); }
            catch (e) {
                throw new SDKGatedFileError('INVALID_PAYLOAD',
                    'Payload is not a Buffer or hex string.', { cause: e.message });
            }
        } else {
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                'Payload must be a Buffer or hex string.');
        }

        if (buf.length < 1 + KEY_LEN)
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                `Payload too short (got ${buf.length} bytes, need at least ${1 + KEY_LEN}).`);

        let version = buf[0];
        if (version !== HANDOFF_VERSION)
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                `Unsupported handoff version: 0x${version.toString(16).padStart(2, '0')}.`);

        let body = buf.subarray(1);
        if (body.length % KEY_LEN !== 0)
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                `Payload body length ${body.length} is not a multiple of ${KEY_LEN}.`);

        let out = [];
        for (let i = 0; i < body.length; i += KEY_LEN) {
            // Copy the subarray so callers can't accidentally mutate the
            // shared parent Buffer when handling individual keys.
            out.push(Buffer.from(body.subarray(i, i + KEY_LEN)));
        }
        return out;
    }

    /**
     * Compress THEN encrypt a gated FILE payload (spec §5.4).
     *
     * The ordering is not a preference, it is the only order that does
     * anything: AES-256-GCM ciphertext is indistinguishable from random, so
     * deflating it afterwards saves nothing (and usually costs a few bytes).
     * The client inverts with decryptAndInflateFileBytes: decrypt, then
     * inflate.
     *
     * The returned `compressionField` is what the caller MUST place in the
     * FILE action's COMPRESSION field. Nothing downstream can derive it: the
     * encoder sees only opaque ciphertext and is forbidden from setting the
     * field on a gated FILE, precisely because on a gated FILE the field means
     * "inflate after decrypt" rather than "inflate these bytes".
     *
     * Known side channel, documented rather than hidden: the on-chain
     * ciphertext length reveals the plaintext's compressibility (a
     * CRIME-family leak, low value against file storage but real). Callers
     * whose compressibility is itself sensitive pass { compress: false }.
     *
     * @param {Buffer|string} plaintext - the ORIGINAL file bytes.
     * @param {object} [options]
     * @param {boolean} [options.compress=true] - opt out to encrypt raw bytes.
     * @param {Buffer} [options.key] - reuse an existing pack key.
     * @param {number} [options.maxRatio] - emit-time ratio guard override.
     * @param {number} [options.maxInputBytes] - input cap override.
     * @returns {Promise<{ciphertext: Buffer, key: Buffer, keyHash: string,
     *                    compressionField: string, compressed: boolean,
     *                    plaintextLength: number, encryptedLength: number}>}
     */
    async compressAndEncryptFileBytes(plaintext, options = {}) {
        let CompressionUtils = require('./compression.js');
        let compression = new CompressionUtils();

        let plaintextBuf = Buffer.isBuffer(plaintext)
            ? plaintext
            : Buffer.from(plaintext == null ? '' : plaintext, 'utf8');

        let compressed = false;
        let compressionField = '';
        let toEncrypt = plaintextBuf;

        if (options.compress !== false) {
            let attempt = await compression.compressIfSmaller(plaintextBuf, options);
            compressed = attempt.compressed;
            compressionField = attempt.compressionField;
            toEncrypt = attempt.bytes;
        }

        let key = options.key;
        let keyHash;
        if (key === undefined || key === null) {
            let generated = this.generateKey();
            key = generated.key;
            keyHash = generated.keyHash;
        } else {
            keyHash = crypto.createHash('sha256').update(key).digest('hex');
        }

        let ciphertext = this.encryptWithKey(toEncrypt, key);

        return {
            ciphertext,
            key,
            keyHash,
            compressionField,
            compressed,
            plaintextLength: plaintextBuf.length,
            encryptedLength: ciphertext.length
        };
    }

    /**
     * Decrypt THEN inflate a gated FILE payload (the inverse of
     * compressAndEncryptFileBytes).
     *
     * Decryption failure THROWS (a wrong key or tampered ciphertext is a real
     * error the caller must see). Inflation failure does NOT: COMPRESSION is
     * sender-asserted and unverified, so a lying field must degrade to
     * stored-form with an explicit indicator rather than crash the reader
     * (spec §5.5). Partial output is never returned.
     *
     * @param {Buffer} ciphertext - [iv(12)][authTag(16)][encrypted]
     * @param {Buffer} key - 32-byte symmetric key.
     * @param {object} [options]
     * @param {boolean|string} [options.compressed] - the FILE's COMPRESSION
     *   field (or a boolean). Anything that is not the deflate-raw code is
     *   treated as raw, so an unknown future code degrades safely.
     * @param {number} [options.maxRatio]
     * @returns {Promise<{bytes: Buffer, inflated: boolean, storedForm: boolean,
     *                    error: string|null}>}
     */
    async decryptAndInflateFileBytes(ciphertext, key, options = {}) {
        let CompressionUtils = require('./compression.js');
        let compression = new CompressionUtils();

        // Throws on GCM auth failure, by design.
        let decrypted = this.decryptFileBytes(ciphertext, key);

        let declared = options.compressed;
        let wantsInflate = (declared === true) ||
            (typeof declared === 'string' && declared === CompressionUtils.COMPRESSION_CODE_DEFLATE_RAW);

        if (!wantsInflate)
            return { bytes: decrypted, inflated: false, storedForm: false, error: null };

        let result = await compression.inflate(decrypted, options);
        return {
            bytes: result.bytes,
            inflated: result.inflated,
            storedForm: result.storedForm,
            error: result.error
        };
    }
}


module.exports = GatedFileUtils;
module.exports.HANDOFF_VERSION = HANDOFF_VERSION;
module.exports.KEY_LEN = KEY_LEN;
module.exports.IV_LEN = IV_LEN;
module.exports.AUTH_TAG_LEN = AUTH_TAG_LEN;
