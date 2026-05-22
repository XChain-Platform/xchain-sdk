/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Token-Gated File Utilities
 *
 * AES-256-GCM symmetric encryption for FILE v1 gated content,
 * key-handoff payload (de)serialization, and pack helpers.
 *
 * The handoff is keyed by KEY_HASH so a pack of files sharing one
 * symmetric key collapses to a single JSON entry. See
 * xchain-documentation/protocol/TOKEN_GATED_CONTENT.md.
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

const HANDOFF_TYPE = 'xchain.gated_keys.v1';


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
                'AES-256-GCM authentication failed — wrong key or tampered ciphertext.',
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
     * Serialize a key map into the `xchain.gated_keys.v1` JSON payload
     * that gets ECIES-encrypted into a MESSAGE v2.
     *
     * @param {Object} keysByHash - { '<keyHash hex>': Buffer key, ... }
     * @returns {string} JSON string.
     */
    serializeKeyPayload(keysByHash) {
        if (!keysByHash || typeof keysByHash !== 'object')
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                'keysByHash must be an object.');

        let keys = {};
        for (let hash of Object.keys(keysByHash)) {
            let k = keysByHash[hash];
            if (!Buffer.isBuffer(k) || k.length !== KEY_LEN)
                throw new SDKGatedFileError('INVALID_KEY',
                    `Key for ${hash} must be a ${KEY_LEN}-byte Buffer.`);
            keys[hash.toLowerCase()] = k.toString('base64');
        }

        return JSON.stringify({ type: HANDOFF_TYPE, keys });
    }

    /**
     * Parse and validate an `xchain.gated_keys.v1` JSON payload after
     * the wallet has ECIES-decrypted a key-handoff MESSAGE.
     *
     * @param {string} plaintext - Decrypted MESSAGE plaintext.
     * @returns {Object} { '<keyHash hex>': Buffer key, ... }
     * @throws SDKGatedFileError if the payload is malformed or wrong type.
     */
    parseKeyPayload(plaintext) {
        if (typeof plaintext !== 'string' || plaintext.length === 0)
            throw new SDKGatedFileError('INVALID_PAYLOAD', 'Plaintext payload required.');

        let parsed;
        try { parsed = JSON.parse(plaintext); }
        catch (e) {
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                'Payload is not valid JSON.', { cause: e.message });
        }

        if (!parsed || parsed.type !== HANDOFF_TYPE)
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                `Payload type must be "${HANDOFF_TYPE}".`,
                { actualType: parsed && parsed.type });
        if (!parsed.keys || typeof parsed.keys !== 'object')
            throw new SDKGatedFileError('INVALID_PAYLOAD',
                'Payload "keys" must be an object.');

        let out = {};
        for (let hash of Object.keys(parsed.keys)) {
            let b64 = parsed.keys[hash];
            if (typeof b64 !== 'string')
                throw new SDKGatedFileError('INVALID_PAYLOAD',
                    `Key for ${hash} must be a base64 string.`);
            let key;
            try { key = Buffer.from(b64, 'base64'); }
            catch (e) {
                throw new SDKGatedFileError('INVALID_PAYLOAD',
                    `Key for ${hash} is not valid base64.`, { cause: e.message });
            }
            if (key.length !== KEY_LEN)
                throw new SDKGatedFileError('INVALID_PAYLOAD',
                    `Decoded key for ${hash} must be ${KEY_LEN} bytes, got ${key.length}.`);
            out[hash.toLowerCase()] = key;
        }
        return out;
    }
}


module.exports = GatedFileUtils;
module.exports.HANDOFF_TYPE = HANDOFF_TYPE;
module.exports.KEY_LEN = KEY_LEN;
module.exports.IV_LEN = IV_LEN;
module.exports.AUTH_TAG_LEN = AUTH_TAG_LEN;
