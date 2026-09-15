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

const crypto = require('crypto');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork } = require('../../protocol/networks.js');
const { SDKMessagingError } = require('../../utils/errors.js');
const { ECPair, IV_LEN, KDF_VERSION_V1 } = require('./kdf_constants.js');

module.exports = {
    _resolveNet(network) {
        if (network) return getNetwork(network);
        if (this._netParams) return this._netParams;
        throw new SDKMessagingError('NETWORK_NOT_CONFIGURED',
            'Network not configured. Provide network in SDK options or pass it to this method.');
    },

    /**
     * Encrypt a message using ECIES for a recipient's public key.
     * Generates an ephemeral keypair per message.
     *
     * @param {string} plaintext - Message to encrypt
     * @param {string|Buffer} recipientPubkey - Recipient's compressed public key (hex or Buffer)
     * @returns {{ ciphertext: string }} - Hex-encoded ciphertext
     */
    eciesEncrypt(plaintext, recipientPubkey) {
        if (!plaintext || typeof plaintext !== 'string')
            throw new SDKMessagingError('INVALID_MESSAGE', 'Plaintext message string is required.');
        if (!recipientPubkey)
            throw new SDKMessagingError('INVALID_PUBKEY', 'Recipient public key is required.');

        let pubkeyBuf = Buffer.isBuffer(recipientPubkey)
            ? recipientPubkey
            : Buffer.from(recipientPubkey, 'hex');

        if (pubkeyBuf.length !== 33 && pubkeyBuf.length !== 65)
            throw new SDKMessagingError('INVALID_PUBKEY', `Invalid public key length: ${pubkeyBuf.length}`);

        // Validate curve point before passing to ECDH (rejects off-curve / small-subgroup points
        // regardless of Node version and guards against future polyfill/shim environments).
        if (!ecc.isPoint(pubkeyBuf))
            throw new SDKMessagingError('INVALID_PUBKEY', 'Recipient public key is not a valid secp256k1 point.');

        let ephemeral = ECPair.makeRandom({ compressed: true });
        let sharedSecret = this._deriveEciesKey(ephemeral.privateKey, pubkeyBuf);

        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack v1: version(1) + ephemeralPubkey(33) + iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([
            Buffer.from([KDF_VERSION_V1]), ephemeral.publicKey, iv, authTag, encrypted
        ]);

        return { ciphertext: ciphertext.toString('hex') };
    },

    /**
     * Decrypt an ECIES-encrypted message using the recipient's private key.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string} wif - Recipient's WIF private key
     * @returns {{ plaintext: string }}
     */
    eciesDecrypt(ciphertext, wif) {
        if (!ciphertext)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext is required.');
        if (!wif || typeof wif !== 'string')
            throw new SDKMessagingError('INVALID_WIF', 'WIF private key is required.');

        let ciphertextBuf = Buffer.isBuffer(ciphertext)
            ? ciphertext
            : Buffer.from(ciphertext, 'hex');

        let net = this._resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKMessagingError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        let { iv, authTag, encrypted, sharedSecret } =
            this._unpackEcies(ciphertextBuf, keyPair.privateKey);

        try {
            let decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
            decipher.setAuthTag(authTag);
            let plaintext = decipher.update(encrypted) + decipher.final('utf8');
            return { plaintext };
        } catch (err) {
            throw new SDKMessagingError('DECRYPTION_FAILED', `ECIES decryption failed: ${err.message}`);
        }
    },

    /**
     * Encrypt raw bytes using ECIES. Mirrors eciesEncrypt but skips the
     * utf8 conversion (for binary payloads, e.g. gated-content key
     * handoffs, where the plaintext is not text).
     *
     * @param {Buffer} plaintext - Bytes to encrypt
     * @param {string|Buffer} recipientPubkey - Recipient's compressed public key (hex or Buffer)
     * @returns {{ ciphertext: string }} - Hex-encoded ciphertext
     */
    eciesEncryptBytes(plaintext, recipientPubkey) {
        if (!Buffer.isBuffer(plaintext))
            throw new SDKMessagingError('INVALID_MESSAGE', 'Plaintext Buffer is required.');
        if (!recipientPubkey)
            throw new SDKMessagingError('INVALID_PUBKEY', 'Recipient public key is required.');

        let pubkeyBuf = Buffer.isBuffer(recipientPubkey)
            ? recipientPubkey
            : Buffer.from(recipientPubkey, 'hex');

        if (pubkeyBuf.length !== 33 && pubkeyBuf.length !== 65)
            throw new SDKMessagingError('INVALID_PUBKEY', `Invalid public key length: ${pubkeyBuf.length}`);

        if (!ecc.isPoint(pubkeyBuf))
            throw new SDKMessagingError('INVALID_PUBKEY', 'Recipient public key is not a valid secp256k1 point.');

        let ephemeral = ECPair.makeRandom({ compressed: true });
        let sharedSecret = this._deriveEciesKey(ephemeral.privateKey, pubkeyBuf);

        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack v1: version(1) + ephemeralPubkey(33) + iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([
            Buffer.from([KDF_VERSION_V1]), ephemeral.publicKey, iv, authTag, encrypted
        ]);
        return { ciphertext: ciphertext.toString('hex') };
    },

    /**
     * Decrypt an ECIES ciphertext into raw bytes (no utf8 conversion).
     * Counterpart to eciesEncryptBytes; preserves binary plaintexts.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string} wif - Recipient's WIF private key
     * @returns {{ plaintext: Buffer }}
     */
    eciesDecryptBytes(ciphertext, wif) {
        if (!ciphertext)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext is required.');
        if (!wif || typeof wif !== 'string')
            throw new SDKMessagingError('INVALID_WIF', 'WIF private key is required.');

        let ciphertextBuf = Buffer.isBuffer(ciphertext)
            ? ciphertext
            : Buffer.from(ciphertext, 'hex');

        let net = this._resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKMessagingError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        let { iv, authTag, encrypted, sharedSecret } =
            this._unpackEcies(ciphertextBuf, keyPair.privateKey);

        try {
            let decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
            decipher.setAuthTag(authTag);
            let plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return { plaintext };
        } catch (err) {
            throw new SDKMessagingError('DECRYPTION_FAILED', `ECIES decryption failed: ${err.message}`);
        }
    }
};
