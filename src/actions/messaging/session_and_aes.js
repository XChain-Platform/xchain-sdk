/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Platform SDK - Messaging Utilities
 *
 * ECIES, ECDH, and AES encryption for MESSAGE actions.
 * High-level send/receive with automatic pubkey resolution
 * and message decryption.
 *
 ********************************************************************/

const { SDKMessagingError } = require('../../utils/errors.js');
const { ECPair } = require('./kdf_constants.js');

module.exports = {
    /**
     * Generate a public key for ECDH key exchange (format 0/1 messages).
     *
     * @param {string} wif - WIF private key
     * @returns {{ publicKey: string }} - Hex-encoded compressed public key
     */
    generateSessionKey(wif) {
        if (!wif || typeof wif !== 'string')
            throw new SDKMessagingError('INVALID_WIF', 'WIF private key is required.');

        let net = this._resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKMessagingError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        return { publicKey: keyPair.publicKey.toString('hex') };
    },

    /**
     * Derive a shared secret from your private key and the other party's public key.
     *
     * @param {string} wif - Your WIF private key
     * @param {string|Buffer} theirPublicKey - Other party's public key (hex or Buffer)
     * @param {Object} [opts={}]
     * @param {boolean} [opts.legacy=false] - Derive the legacy bare-SHA256
     *        secret instead of v1 HKDF. Use ONLY to interoperate with a session
     *        established under the legacy derivation.
     * @returns {{ sharedSecret: string }} - Hex-encoded 32-byte shared secret
     */
    deriveSharedSecret(wif, theirPublicKey, opts = {}) {
        if (!wif || typeof wif !== 'string')
            throw new SDKMessagingError('INVALID_WIF', 'WIF private key is required.');
        if (!theirPublicKey)
            throw new SDKMessagingError('INVALID_PUBKEY', 'Their public key is required.');

        let net = this._resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKMessagingError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        let pubkeyBuf = Buffer.isBuffer(theirPublicKey)
            ? theirPublicKey
            : Buffer.from(theirPublicKey, 'hex');

        let secret = opts.legacy
            ? this.deriveECDHSecretLegacy(keyPair.privateKey, pubkeyBuf)
            : this.deriveEcdhSessionKey(keyPair.privateKey, pubkeyBuf);
        return { sharedSecret: secret.toString('hex') };
    },

    /**
     * Encrypt a message using a shared secret (from ECDH key exchange).
     *
     * @param {string} plaintext
     * @param {string|Buffer} sharedSecret - 32-byte shared secret (hex or Buffer)
     * @returns {{ ciphertext: string }} - Hex-encoded ciphertext (iv + authTag + encrypted)
     */
    sessionEncrypt(plaintext, sharedSecret) {
        if (!plaintext || typeof plaintext !== 'string')
            throw new SDKMessagingError('INVALID_MESSAGE', 'Plaintext message string is required.');

        let key = this.toBuffer(sharedSecret, 'sharedSecret');
        return this._aesEncrypt(plaintext, key);
    },

    /**
     * Decrypt a message using a shared secret (from ECDH key exchange).
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedSecret - 32-byte shared secret (hex or Buffer)
     * @returns {{ plaintext: string }}
     */
    sessionDecrypt(ciphertext, sharedSecret) {
        let key = this.toBuffer(sharedSecret, 'sharedSecret');
        return this._aesDecrypt(ciphertext, key);
    },

    /**
     * Encrypt raw bytes using a shared secret (from ECDH key exchange).
     * Counterpart to sessionEncrypt for binary payloads (no utf8 conversion).
     *
     * @param {Buffer} plaintext - Bytes to encrypt
     * @param {string|Buffer} sharedSecret - 32-byte shared secret (hex or Buffer)
     * @returns {{ ciphertext: string }} - Hex-encoded ciphertext (iv + authTag + encrypted)
     */
    sessionEncryptBytes(plaintext, sharedSecret) {
        if (!Buffer.isBuffer(plaintext) || plaintext.length === 0)
            throw new SDKMessagingError('INVALID_MESSAGE', 'Plaintext Buffer is required.');

        let key = this.toBuffer(sharedSecret, 'sharedSecret');
        return this._aesEncryptBytes(plaintext, key);
    },

    /**
     * Decrypt a session ciphertext into raw bytes (no utf8 conversion).
     * Counterpart to sessionEncryptBytes; preserves binary plaintexts.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedSecret - 32-byte shared secret (hex or Buffer)
     * @returns {{ plaintext: Buffer }}
     */
    sessionDecryptBytes(ciphertext, sharedSecret) {
        let key = this.toBuffer(sharedSecret, 'sharedSecret');
        return this._aesDecryptBytes(ciphertext, key);
    },

    /**
     * Encrypt a message with a pre-shared AES key.
     *
     * @param {string} plaintext
     * @param {string|Buffer} sharedKey - 32-byte key (hex or Buffer). If shorter, will be hashed to 32 bytes.
     * @returns {{ ciphertext: string }} - Hex-encoded ciphertext (iv + authTag + encrypted)
     */
    aesEncrypt(plaintext, sharedKey) {
        if (!plaintext || typeof plaintext !== 'string')
            throw new SDKMessagingError('INVALID_MESSAGE', 'Plaintext message string is required.');

        let key = this.normalizeKey(sharedKey);
        return this._aesEncrypt(plaintext, key);
    },

    /**
     * Decrypt a message with a pre-shared AES key.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedKey - Same key used for encryption
     * @returns {{ plaintext: string }}
     */
    aesDecrypt(ciphertext, sharedKey) {
        let key = this.normalizeKey(sharedKey);
        return this._aesDecrypt(ciphertext, key);
    },

    /**
     * Encrypt raw bytes with a pre-shared AES key.
     * Counterpart to aesEncrypt for binary payloads (no utf8 conversion).
     *
     * @param {Buffer} plaintext - Bytes to encrypt
     * @param {string|Buffer} sharedKey - 32-byte key (hex or Buffer). If shorter, will be hashed to 32 bytes.
     * @returns {{ ciphertext: string }} - Hex-encoded ciphertext (iv + authTag + encrypted)
     */
    aesEncryptBytes(plaintext, sharedKey) {
        if (!Buffer.isBuffer(plaintext) || plaintext.length === 0)
            throw new SDKMessagingError('INVALID_MESSAGE', 'Plaintext Buffer is required.');

        let key = this.normalizeKey(sharedKey);
        return this._aesEncryptBytes(plaintext, key);
    },

    /**
     * Decrypt an AES ciphertext into raw bytes (no utf8 conversion).
     * Counterpart to aesEncryptBytes; preserves binary plaintexts.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedKey - Same key used for encryption
     * @returns {{ plaintext: Buffer }}
     */
    aesDecryptBytes(ciphertext, sharedKey) {
        let key = this.normalizeKey(sharedKey);
        return this._aesDecryptBytes(ciphertext, key);
    },

    /**
     * Look up the public key for an address via the explorer API.
     *
     * @param {string} address
     * @param {Object} explorer - ExplorerClient instance
     * @returns {Promise<string|null>} - Hex-encoded public key, or null if not found
     */
    async getPublicKey(address, explorer) {
        if (!address || typeof address !== 'string')
            throw new SDKMessagingError('INVALID_ADDRESS', 'Address is required for public key lookup.');
        if (!explorer)
            throw new SDKMessagingError('EXPLORER_REQUIRED',
                'Explorer client is required. Use sdk.messaging.getPublicKey(address, sdk.explorer).');

        let result = await explorer.getPublicKey(address);
        if (result && result.pubkey) return result.pubkey;
        return null;
    }
};
