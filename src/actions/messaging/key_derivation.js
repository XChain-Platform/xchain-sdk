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
const { SDKMessagingError } = require('../../utils/errors.js');
const {
    EPHEMERAL_PUBKEY_LEN, IV_LEN, AUTH_TAG_LEN, ECIES_OVERHEAD,
    KDF_VERSION_V0, KDF_VERSION_V1, HKDF_SALT, HKDF_INFO_ECIES,
    HKDF_INFO_ECDH, HKDF_KEY_LEN, hkdfSha256
} = require('./kdf_constants.js');

module.exports = {
    // Compute the raw ECDH product (uniform input keying material for the KDF).
    ecdhProduct(privateKey, publicKey) {
        let ecdh = crypto.createECDH('secp256k1');
        ecdh.setPrivateKey(privateKey);
        return ecdh.computeSecret(publicKey);
    },

    // v0 legacy derivation: bare SHA256 over the raw ECDH product, no domain
    // separation. Kept ONLY for decrypting old-version blobs / legacy sessions.
    deriveECDHSecretLegacy(privateKey, publicKey) {
        let raw = this.ecdhProduct(privateKey, publicKey);
        return crypto.createHash('sha256').update(raw).digest();
    },

    // v1 KDF: HKDF-SHA256 over the raw ECDH product with a fixed protocol salt
    // and a per-method `info` label. The differing `info` per method is what
    // guarantees cross-method domain separation: a key that leaks from one
    // method cannot be replayed to read messages protected by the other.
    hkdfFromEcdh(privateKey, publicKey, info) {
        let raw = this.ecdhProduct(privateKey, publicKey);
        return hkdfSha256(raw, HKDF_SALT, info, HKDF_KEY_LEN);
    },

    // Test-only handle on the module-private HKDF, so the suite can pin it
    // against Node's builtin on arbitrary salt/info/length vectors.
    hkdfSha256Test(ikm, salt, info, length) {
        return hkdfSha256(ikm, salt, info, length);
    },

    // v1 ECIES key (info = xchain-ecies-v1)
    deriveEciesKey(privateKey, publicKey) {
        return this.hkdfFromEcdh(privateKey, publicKey, HKDF_INFO_ECIES);
    },

    // v1 ECDH-session key (info = xchain-ecdh-session-v1)
    deriveEcdhSessionKey(privateKey, publicKey) {
        return this.hkdfFromEcdh(privateKey, publicKey, HKDF_INFO_ECDH);
    },

    // Unpack a (possibly versioned) ECIES envelope and derive the matching key.
    //   v1: [0x01][ephemeralPubkey(33)][iv(12)][authTag(16)][encrypted] -> HKDF
    //   v0: [ephemeralPubkey(33)][iv(12)][authTag(16)][encrypted]       -> legacy SHA256
    // A compressed pubkey always starts with 0x02/0x03, so byte 0 == 0x01
    // unambiguously identifies a v1 blob.
    unpackEcies(buf, recipientPrivateKey) {
        let version, offset;
        if (buf.length > 0 && buf[0] === KDF_VERSION_V1) {
            version = KDF_VERSION_V1;
            offset = 1;
        } else {
            version = KDF_VERSION_V0;
            offset = 0;
        }

        if (buf.length < offset + ECIES_OVERHEAD)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext too short to contain ECIES data.');

        let ephemeralPubkey = buf.subarray(offset, offset + EPHEMERAL_PUBKEY_LEN);
        let iv              = buf.subarray(offset + EPHEMERAL_PUBKEY_LEN, offset + EPHEMERAL_PUBKEY_LEN + IV_LEN);
        let authTag         = buf.subarray(offset + EPHEMERAL_PUBKEY_LEN + IV_LEN, offset + ECIES_OVERHEAD);
        let encrypted       = buf.subarray(offset + ECIES_OVERHEAD);

        // Validate the attacker-supplied ephemeral point BEFORE it meets our private
        // key. This is the same guard eciesEncrypt applies to the recipient pubkey,
        // and decrypt is the side that actually matters for an invalid-curve attack
        // (a crafted off-curve / small-subgroup ephemeral could leak private-key bits
        // through an ECDH that doesn't self-validate). Node/OpenSSL rejects such
        // points today, but this keeps the guarantee independent of the ECDH backend.
        if (!ecc.isPoint(ephemeralPubkey))
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'ECIES ephemeral public key is not a valid secp256k1 point.');

        let sharedSecret = version === KDF_VERSION_V1
            ? this.deriveEciesKey(recipientPrivateKey, ephemeralPubkey)
            : this.deriveECDHSecretLegacy(recipientPrivateKey, ephemeralPubkey);

        return { version, iv, authTag, encrypted, sharedSecret };
    },

    aesEncryptWithKey(plaintext, key) {
        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack: iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([iv, authTag, encrypted]);
        return { ciphertext: ciphertext.toString('hex') };
    },

    // Binary counterpart to aesEncryptWithKey: same envelope, no utf8 conversion.
    _aesEncryptBytes(plaintext, key) {
        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack: iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([iv, authTag, encrypted]);
        return { ciphertext: ciphertext.toString('hex') };
    },

    aesDecryptWithKey(ciphertext, key) {
        let { plaintext } = this._aesDecryptBytes(ciphertext, key);
        return { plaintext: plaintext.toString('utf8') };
    },

    // Binary counterpart to aesDecryptWithKey: returns the raw plaintext Buffer.
    _aesDecryptBytes(ciphertext, key) {
        if (!ciphertext)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext is required.');

        let buf = Buffer.isBuffer(ciphertext)
            ? ciphertext
            : Buffer.from(ciphertext, 'hex');

        if (buf.length < IV_LEN + AUTH_TAG_LEN)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext too short.');

        let iv        = buf.subarray(0, IV_LEN);
        let authTag   = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
        let encrypted = buf.subarray(IV_LEN + AUTH_TAG_LEN);

        try {
            let decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            let plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return { plaintext };
        } catch (err) {
            throw new SDKMessagingError('DECRYPTION_FAILED', `Decryption failed: ${err.message}`);
        }
    },

    normalizeKey(key) {
        if (!key)
            throw new SDKMessagingError('INVALID_KEY', 'Encryption key is required.');

        let buf = this.toBuffer(key, 'key');
        if (buf.length === 32) return buf;
        return crypto.createHash('sha256').update(buf).digest();
    },

    toBuffer(value, name) {
        if (Buffer.isBuffer(value)) return value;
        if (typeof value === 'string') return Buffer.from(value, 'hex');
        throw new SDKMessagingError('INVALID_TYPE', `${name} must be a hex string or Buffer.`);
    }
};
