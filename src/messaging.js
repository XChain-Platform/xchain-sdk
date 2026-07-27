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
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const { getNetwork } = require('./networks.js');
const { SDKMessagingError } = require('./errors.js');

const ECPair = ECPairFactory(ecc);

// ECIES ciphertext layout:
// [ephemeralPubkey (33 bytes)] [iv (12 bytes)] [authTag (16 bytes)] [encrypted data]
const EPHEMERAL_PUBKEY_LEN = 33;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const ECIES_OVERHEAD = EPHEMERAL_PUBKEY_LEN + IV_LEN + AUTH_TAG_LEN;

// Encryption method constants
const METHOD_ECIES = 1;
const METHOD_ECDH  = 2;
const METHOD_AES   = 3;

// Cap on distinct counterparty pubkey lookups per getMessages() sweep. Every
// cache miss in the ECDH fallback is an explorer round-trip, so an inbox
// stuffed with undecryptable messages from unique senders would otherwise fan
// out one network request per sender. Once the budget is spent the sweep stops
// resolving new counterparties and leaves those rows encrypted; callers that
// genuinely need a wider sweep raise it with opts.maxPubkeyLookups.
const ECDH_MAX_PUBKEY_LOOKUPS = 25;

// -----------------------------------------------------------------------------
//  ECDH key-derivation versioning (fix #3520)
//
//  Legacy (v0) derivation was a bare SHA256(raw_ecdh_product) with no HKDF and
//  no domain separation: the SAME raw ECDH product produced the SAME AES key
//  regardless of which method (ECIES vs ECDH-session) consumed it. v1 replaces
//  this with HKDF-SHA256 and a per-method `info` label so the two methods can
//  never collide, even with an identical ECDH product.
//
//  Envelope versioning (ECIES only): the ECIES ciphertext is framed as
//    [ephemeralPubkey(33)] [iv(12)] [authTag(16)] [encrypted]
//  A compressed secp256k1 pubkey ALWAYS begins with 0x02 or 0x03, so a v0 blob
//  never starts with any other byte. v1 blobs therefore prepend a single
//  version byte (KDF_VERSION_V1 = 0x01) which is unambiguous against 0x02/0x03.
//  On decrypt we sniff byte 0: 0x01 -> v1 (HKDF), 0x02/0x03 -> v0 (legacy SHA256).
//
//  ECDH-session (deriveSharedSecret) returns a RAW 32-byte secret with no
//  envelope to version. Pre-launch, sessions are short-lived and established
//  out-of-band, so deriveSharedSecret() now derives the v1 HKDF secret by
//  default; the legacy secret stays reachable via the `legacy` option for any
//  pre-existing session that must still interoperate.
// -----------------------------------------------------------------------------
const KDF_VERSION_V0 = 0;       // bare SHA256(raw ecdh product), no domain sep
const KDF_VERSION_V1 = 1;       // HKDF-SHA256 with per-method info label

// Fixed protocol-domain salt for HKDF. A constant (non-secret) salt is the
// standard HKDF choice when no high-entropy salt is available; domain
// separation is carried by the per-method `info` label below. The bytes are
// the ASCII of "xchain-messaging-kdf-v1".
const HKDF_SALT = Buffer.from('xchain-messaging-kdf-v1', 'utf8');

// Per-method HKDF `info` labels. These MUST differ so an identical ECDH
// product can never derive the same key across methods.
const HKDF_INFO_ECIES = Buffer.from('xchain-ecies-v1', 'utf8');
const HKDF_INFO_ECDH  = Buffer.from('xchain-ecdh-session-v1', 'utf8');

const HKDF_KEY_LEN = 32;        // AES-256 key

/**
 * HKDF-SHA256 (RFC 5869), extract-then-expand.
 *
 * Node's `crypto.hkdfSync` does the same thing, but it does NOT exist in the
 * browser crypto shims the wallet's web / extension / desktop-renderer shells
 * build against, where it throws "crypto2.hkdfSync is not a function". That
 * killed every v1 encrypt AND decrypt in a browser - which is the whole
 * messaging feature outside Node . HMAC-SHA256 is present in those
 * shims, so the two RFC 5869 steps are done here instead: extract a PRK with
 * the salt as the HMAC key, then expand it one 32-byte block at a time.
 *
 * The output is byte-identical to `crypto.hkdfSync('sha256', ...)`; a unit
 * test pins that equality against the builtin wherever the builtin exists, so
 * a browser-derived key and a Node-derived key can never diverge - they have
 * to agree, or a message encrypted in one cannot be read in the other.
 *
 * @param {Buffer} ikm    input keying material (the raw ECDH product)
 * @param {Buffer} salt   protocol salt
 * @param {Buffer} info   per-method domain-separation label
 * @param {number} length bytes of key material to produce
 * @returns {Buffer}
 */
function hkdfSha256(ikm, salt, info, length) {
    // Extract: PRK = HMAC(salt, ikm). RFC 5869 defines an all-zero salt of
    // hash length when none is given; ours is always supplied.
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    // Expand: T(n) = HMAC(PRK, T(n-1) || info || n), concatenated and truncated.
    const blocks = Math.ceil(length / 32);
    if (blocks > 255) throw new SDKMessagingError('hkdfSha256: requested length exceeds RFC 5869 maximum');
    let prev = Buffer.alloc(0);
    const out = [];
    for (let i = 1; i <= blocks; i++) {
        prev = crypto.createHmac('sha256', prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest();
        out.push(prev);
    }
    return Buffer.concat(out).subarray(0, length);
}

/**
 * Resolve a caller-supplied ECDH pubkey-lookup budget to a usable count.
 * 0 disables the ECDH fallback's network lookups entirely and Infinity opts
 * out of the cap; anything not a non-negative number falls back to the default
 * so a bad option can never widen the budget.
 *
 * @param {*} value  opts.maxPubkeyLookups as supplied by the caller
 * @returns {number}
 */
function normalizeLookupBudget(value) {
    if (value === undefined || value === null) return ECDH_MAX_PUBKEY_LOOKUPS;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return ECDH_MAX_PUBKEY_LOOKUPS;
    return Math.floor(value);   // Infinity floors to Infinity, so "no cap" survives
}


class MessagingUtils {

    constructor(network) {
        this.network = network || null;
        this._netParams = network ? getNetwork(network) : null;
    }

    _resolveNet(network) {
        if (network) return getNetwork(network);
        if (this._netParams) return this._netParams;
        throw new SDKMessagingError('NETWORK_NOT_CONFIGURED',
            'Network not configured. Provide network in SDK options or pass it to this method.');
    }

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
    }

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
    }

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
    }

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
    }

    /**
     * Derive a shared secret from your private key and the other party's public key.
     *
     * @param {string} wif - Your WIF private key
     * @param {string|Buffer} theirPublicKey - Other party's public key (hex or Buffer)
     * @param {Object} [opts={}]
     * @param {boolean} [opts.legacy=false] - Derive the pre-#3520 bare-SHA256
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
            ? this._deriveECDHSecretLegacy(keyPair.privateKey, pubkeyBuf)
            : this._deriveEcdhSessionKey(keyPair.privateKey, pubkeyBuf);
        return { sharedSecret: secret.toString('hex') };
    }

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

        let key = this._toBuffer(sharedSecret, 'sharedSecret');
        return this._aesEncrypt(plaintext, key);
    }

    /**
     * Decrypt a message using a shared secret (from ECDH key exchange).
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedSecret - 32-byte shared secret (hex or Buffer)
     * @returns {{ plaintext: string }}
     */
    sessionDecrypt(ciphertext, sharedSecret) {
        let key = this._toBuffer(sharedSecret, 'sharedSecret');
        return this._aesDecrypt(ciphertext, key);
    }

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

        let key = this._toBuffer(sharedSecret, 'sharedSecret');
        return this._aesEncryptBytes(plaintext, key);
    }

    /**
     * Decrypt a session ciphertext into raw bytes (no utf8 conversion).
     * Counterpart to sessionEncryptBytes; preserves binary plaintexts.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedSecret - 32-byte shared secret (hex or Buffer)
     * @returns {{ plaintext: Buffer }}
     */
    sessionDecryptBytes(ciphertext, sharedSecret) {
        let key = this._toBuffer(sharedSecret, 'sharedSecret');
        return this._aesDecryptBytes(ciphertext, key);
    }

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

        let key = this._normalizeKey(sharedKey);
        return this._aesEncrypt(plaintext, key);
    }

    /**
     * Decrypt a message with a pre-shared AES key.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedKey - Same key used for encryption
     * @returns {{ plaintext: string }}
     */
    aesDecrypt(ciphertext, sharedKey) {
        let key = this._normalizeKey(sharedKey);
        return this._aesDecrypt(ciphertext, key);
    }

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

        let key = this._normalizeKey(sharedKey);
        return this._aesEncryptBytes(plaintext, key);
    }

    /**
     * Decrypt an AES ciphertext into raw bytes (no utf8 conversion).
     * Counterpart to aesEncryptBytes; preserves binary plaintexts.
     *
     * @param {string|Buffer} ciphertext - Hex-encoded ciphertext
     * @param {string|Buffer} sharedKey - Same key used for encryption
     * @returns {{ plaintext: Buffer }}
     */
    aesDecryptBytes(ciphertext, sharedKey) {
        let key = this._normalizeKey(sharedKey);
        return this._aesDecryptBytes(ciphertext, key);
    }

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

    /**
     * Send a message to a destination address.
     * Handles pubkey lookup, encryption, action creation, signing, and broadcasting.
     *
     * @param {Object} params
     * @param {string} params.wif - Sender's WIF private key
     * @param {string} params.coin - Destination coin network (BTC, LTC, DOGE)
     * @param {string} params.destination - Recipient address
     * @param {string|Buffer} params.message - Message content. A Buffer triggers the
     *                                          binary encrypt path (no utf8 conversion)
     *                                          for ECIES, ECDH, and AES methods; used for
     *                                          gated-content key handoffs and other
     *                                          binary payloads.
     * @param {number} [params.method=1] - Encryption method (1=ECIES, 2=ECDH, 3=AES, null=plaintext)
     * @param {string|Buffer} [params.sharedSecret] - Required for method 2 (ECDH)
     * @param {string|Buffer} [params.sharedKey] - Required for method 3 (AES)
     * @param {Object} params.encoder - Encoder options (pubkey required)
     * @param {Object} sdk - XChainSDK instance
     * @returns {Promise<{ txid: string, actionString: string }>}
     */
    async send(params, sdk) {
        if (!params.wif || typeof params.wif !== 'string')
            throw new SDKMessagingError('INVALID_WIF', 'WIF private key is required.');
        if (!params.coin || typeof params.coin !== 'string')
            throw new SDKMessagingError('INVALID_COIN', 'Destination coin is required (BTC, LTC, DOGE).');
        if (!params.destination || typeof params.destination !== 'string')
            throw new SDKMessagingError('INVALID_DESTINATION', 'Destination address is required.');
        let messageIsBytes = Buffer.isBuffer(params.message);
        if (params.message === undefined || params.message === null
            || (!messageIsBytes && typeof params.message !== 'string')
            || (typeof params.message === 'string' && params.message.length === 0)
            || (messageIsBytes && params.message.length === 0))
            throw new SDKMessagingError('INVALID_MESSAGE', 'Message is required (string or Buffer).');
        if (!params.encoder)
            throw new SDKMessagingError('ENCODER_REQUIRED', 'Encoder options are required.');
        if (!sdk)
            throw new SDKMessagingError('SDK_REQUIRED', 'SDK instance is required. Use sdk.sendMessage() instead.');

        let method = params.method !== undefined ? params.method : METHOD_ECIES;
        let actionParams = { coin: params.coin.toUpperCase(), destination: params.destination };
        let encryptedMessage;

        if (method === null) {
            // Plaintext (format 3): binary payloads cannot be sent unencrypted
            if (messageIsBytes)
                throw new SDKMessagingError('INVALID_MESSAGE',
                    'Plaintext (method=null) requires a string message; binary payloads must be encrypted.');
            actionParams.plaintextMessage = params.message;

        } else if (method === METHOD_ECIES) {
            // ECIES: look up recipient pubkey and encrypt
            let explorer = sdk._requireExplorer();
            let recipientPubkey = await this.getPublicKey(params.destination, explorer);
            if (!recipientPubkey)
                throw new SDKMessagingError('PUBKEY_NOT_FOUND',
                    `No public key found for ${params.destination}. The address may not have sent any XChain transactions yet.`);

            let result = messageIsBytes
                ? this.eciesEncryptBytes(params.message, recipientPubkey)
                : this.eciesEncrypt(params.message, recipientPubkey);
            // MESSAGE v2 (VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE) carries no
            // ENCRYPTION_METHOD on the wire; absence implies ECIES (1) by protocol.
            // Setting encryptionMethod here would add a field with no v2 slot and the
            // format selector would reject every version (NO_MATCHING_FORMAT), so the
            // method is deliberately kept off actionParams.
            actionParams.encryptedMessage = result.ciphertext;

        } else if (method === METHOD_ECDH) {
            // ECDH: requires a pre-derived shared secret
            if (!params.sharedSecret)
                throw new SDKMessagingError('SHARED_SECRET_REQUIRED',
                    'Shared secret is required for ECDH encryption. Use deriveSharedSecret() first.');

            let result = messageIsBytes
                ? this.sessionEncryptBytes(params.message, params.sharedSecret)
                : this.sessionEncrypt(params.message, params.sharedSecret);
            // v2 has no ENCRYPTION_METHOD slot (see ECIES branch above); the ECDH
            // session is established out-of-band via v0/v1 key exchange, so the
            // method stays off the wire.
            actionParams.encryptedMessage = result.ciphertext;

        } else if (method === METHOD_AES) {
            // AES: requires a pre-shared key
            if (!params.sharedKey)
                throw new SDKMessagingError('SHARED_KEY_REQUIRED',
                    'Shared key is required for AES encryption.');

            let result = messageIsBytes
                ? this.aesEncryptBytes(params.message, params.sharedKey)
                : this.aesEncrypt(params.message, params.sharedKey);
            // v2 has no ENCRYPTION_METHOD slot (see ECIES branch above); the AES
            // shared key is distributed out-of-band, so the method stays off the wire.
            actionParams.encryptedMessage = result.ciphertext;

        } else {
            throw new SDKMessagingError('INVALID_METHOD',
                `Invalid encryption method: ${method}. Use 1 (ECIES), 2 (ECDH), 3 (AES), or null (plaintext).`);
        }

        let actionResult = await sdk.createAction({
            action: 'MESSAGE',
            params: actionParams,
            encoder: params.encoder
        });

        let signed = sdk.wallet.signPsbt(actionResult.psbt, params.wif);
        let broadcast = await sdk.wallet.broadcastTx(signed.txHex, sdk._requireEncoder());

        return {
            txid: signed.txid,
            actionString: actionResult.actionString
        };
    }

    /**
     * Fetch messages for an address, optionally decrypting them.
     *
     * @param {string} address - Address to query messages for
     * @param {Object} [opts={}]
     * @param {string} [opts.wif] - WIF private key for decrypting received messages (ECIES)
     * @param {string} [opts.type='all'] - 'sent', 'received' (destination), or 'all' (address)
     * @param {number} [opts.limit] - Pagination limit
     * @param {number} [opts.page] - Pagination page
     * @param {string} [opts.sortorder] - Sort order
     * @param {number} [opts.maxPubkeyLookups=25] - Cap on distinct counterparty
     *        pubkey lookups the ECDH fallback may make for this call (per
     *        explorer, so getAllMessages spends the budget once per chain).
     *        Rows past the cap stay encrypted. 0 disables ECDH lookups,
     *        Infinity removes the cap.
     * @param {Object} explorer - ExplorerClient instance
     * @returns {Promise<Array<{ from: string, to: string, text: string|null, bytes: Buffer|null, encrypted: boolean, method: number|null, txid: string, block: number, timestamp: number }>>}
     *
     * For ECIES messages with `wif` supplied, `bytes` is the raw decrypted
     * Buffer and `text` is its utf8 interpretation. Binary payloads (e.g.
     * gated-content key handoffs) should read `bytes` to avoid utf8
     * corruption; conversational messages keep using `text` unchanged.
     */
    async getMessages(address, opts = {}, explorer) {
        if (!address || typeof address !== 'string')
            throw new SDKMessagingError('INVALID_ADDRESS', 'Address is required.');
        if (!explorer)
            throw new SDKMessagingError('EXPLORER_REQUIRED', 'Explorer client is required.');

        let type = opts.type || 'all';
        let queryType;
        if (type === 'sent')     queryType = 'source';
        else if (type === 'received') queryType = 'destination';
        else                          queryType = 'address';

        let paginationOpts = {};
        if (opts.limit !== undefined)     paginationOpts.limit = opts.limit;
        if (opts.page !== undefined)      paginationOpts.page = opts.page;
        if (opts.sortorder !== undefined) paginationOpts.sortorder = opts.sortorder;

        let rawMessages = await explorer.getMessages(address, queryType, paginationOpts);

        // The explorer serves every list endpoint as `{ data: [...], total }`,
        // and `_get` hands that body back untouched. Requiring a bare array here
        // meant a real explorer response always failed the check and the inbox
        // returned EMPTY - so a MESSAGE that is on-chain, valid and addressed to
        // you was invisible in the wallet, silently . Accept both shapes:
        // a bare array is what the unit-test doubles return.
        if (rawMessages && !Array.isArray(rawMessages) && Array.isArray(rawMessages.data))
            rawMessages = rawMessages.data;

        if (!rawMessages || !Array.isArray(rawMessages)) return [];

        let results = [];
        // Per-call pubkey resolution state for the ECDH fallback. `cache` maps
        // counterparty address -> resolved pubkey (null included, so an
        // unresolvable sender costs one lookup no matter how many messages it
        // sent), and `remaining` is the network-lookup budget for cache misses.
        let pubkeyCache = {
            cache: new Map(),
            remaining: normalizeLookupBudget(opts.maxPubkeyLookups)
        };
        for (let msg of rawMessages) {
            // MESSAGE v2 carries no ENCRYPTION_METHOD on the wire; absence implies
            // ECIES (1) by protocol. The indexer stamps 1 for v2 rows, but legacy
            // rows (indexed before that change) may still carry a null method, so
            // infer ECIES here whenever an encrypted body is present without a method.
            let method = msg.encryption_method ? Number(msg.encryption_method) : null;
            if (method === null && msg.encrypted_message)
                method = METHOD_ECIES;

            let entry = {
                from:      msg.source || null,
                to:        msg.destination || null,
                coin:      msg.coin || null,
                chain:     opts._chain || null,
                text:      null,
                bytes:     null,
                encrypted: false,
                method:    method,
                // The counterparty's published pubkey + the wire format, surfaced
                // so handshake-aware callers can read format-0/1 key-exchange rows
                // (encryption_key) that getMessages otherwise drops.
                encryptionKey: msg.encryption_key || null,
                format:    (msg.action_format === undefined || msg.action_format === null)
                    ? null : Number(msg.action_format),
                txid:      msg.tx_hash || null,
                block:     msg.block_index || null,
                // The explorer /messages contract projects the block time as
                // `timestamp` (db.js: `b1.block_time as timestamp`); accept the
                // raw column name too for any non-explorer row source.
                timestamp: msg.timestamp || msg.block_time || null
            };

            if (msg.plaintext_message) {
                entry.text = msg.plaintext_message;
            } else if (msg.encrypted_message && opts.wif) {
                // An encrypted payload is format 2 on the wire with no method or
                // key, so the indexer stamps it method=1 (ECIES) and an ECDH
                // payload is byte-identical to an ECIES one. Try ECIES first
                // (recipient private key only); on a miss, fall back to an ECDH
                // session decrypt keyed by the counterparty's address pubkey.
                // AES-256-GCM authentication makes a wrong key fail cleanly, so
                // the fallback can never produce a false decrypt.
                try {
                    // Decrypt to raw bytes so binary payloads (gated-content
                    // handoffs) survive intact, then surface the utf8 view
                    // for conversational callers.
                    let result = this.eciesDecryptBytes(msg.encrypted_message, opts.wif);
                    entry.bytes = result.plaintext;
                    entry.text  = result.plaintext.toString('utf8');
                } catch (err) {
                    // Not an ECIES message for us; the ECDH fallback runs below.
                }
                if (entry.text === null) {
                    let plaintext = await this._tryEcdhDecrypt(msg, address, opts.wif, explorer, pubkeyCache);
                    if (plaintext !== null) {
                        entry.bytes  = plaintext;
                        entry.text   = plaintext.toString('utf8');
                        entry.method = METHOD_ECDH;  // correct the stamped-as-ECIES label
                    }
                }
                // AES (method 3) needs an out-of-band shared key we don't have;
                // those stay encrypted with text=null.
                entry.encrypted = true;
            } else if (msg.encrypted_message) {
                entry.encrypted = true;
            }

            results.push(entry);
        }

        return results;
    }

    /**
     * Attempt an ECDH session decrypt of an encrypted message that ECIES
     * couldn't open. The shared secret is deterministic from the two parties'
     * permanent address keys, so it derives `ECDH(myWif, counterpartyPubkey)`
     * (the counterparty being whichever side of the message isn't the inbox
     * `address`), resolving the counterparty's pubkey on-chain. Tries the v1
     * HKDF derivation first, then the v0 legacy SHA256 secret. Returns the
     * plaintext Buffer (caller derives the utf8 view), or null when the
     * pubkey is unresolvable or no key matches.
     *
     * @param {Object} msg            raw message row (needs source/destination/encrypted_message)
     * @param {string} address        the inbox address being read
     * @param {string} wif            our private key
     * @param {Object} explorer       explorer client for pubkey lookup
     * @param {{cache: Map<string,string|null>, remaining: number}} pubkeyCache
     *        per-call pubkey cache plus the remaining network-lookup budget
     * @returns {Promise<Buffer|null>}
     */
    async _tryEcdhDecrypt(msg, address, wif, explorer, pubkeyCache) {
        let counterparty = msg.source === address ? msg.destination : msg.source;
        if (!counterparty) return null;

        let pubkey = pubkeyCache.cache.get(counterparty);
        if (pubkey === undefined) {
            // Budget spent: give up on unseen counterparties for the rest of
            // this sweep instead of paying an explorer round-trip per message.
            // Already-cached senders keep decrypting normally.
            if (pubkeyCache.remaining <= 0) return null;
            pubkeyCache.remaining--;
            try { pubkey = await this.getPublicKey(counterparty, explorer); }
            catch (err) { pubkey = null; }
            pubkeyCache.cache.set(counterparty, pubkey);
        }
        if (!pubkey) return null;

        for (let legacy of [false, true]) {
            try {
                let { sharedSecret } = this.deriveSharedSecret(wif, pubkey, { legacy });
                let { plaintext } = this.sessionDecryptBytes(msg.encrypted_message, sharedSecret);
                return plaintext;
            } catch (err) {
                // wrong derivation version or not an ECDH message; try the next
            }
        }
        return null;
    }

    /**
     * Fetch messages for an address across all chains.
     * Queries each provided explorer and merges results.
     *
     * @param {string} address - Address to query messages for
     * @param {Object} [opts={}] - Same options as getMessages (wif, type, limit, page, sortorder)
     * @param {Object[]} explorers - Array of { explorer: ExplorerClient, chain: string } objects
     * @returns {Promise<Array>} - Merged and sorted messages from all chains
     */
    async getAllMessages(address, opts = {}, explorers) {
        if (!address || typeof address !== 'string')
            throw new SDKMessagingError('INVALID_ADDRESS', 'Address is required.');
        if (!explorers || !Array.isArray(explorers) || explorers.length === 0)
            throw new SDKMessagingError('EXPLORER_REQUIRED', 'At least one explorer is required.');

        let allMessages = [];

        let queries = explorers.map(({ explorer, chain }) => {
            return this.getMessages(address, { ...opts, _chain: chain }, explorer)
                .then(messages => { allMessages.push(...messages); })
                .catch(() => { /* Explorer unavailable; skip */ });
        });

        await Promise.all(queries);

        allMessages.sort((a, b) => (b.block || 0) - (a.block || 0));

        return allMessages;
    }

    // Compute the raw ECDH product (uniform input keying material for the KDF).
    _ecdhProduct(privateKey, publicKey) {
        let ecdh = crypto.createECDH('secp256k1');
        ecdh.setPrivateKey(privateKey);
        return ecdh.computeSecret(publicKey);
    }

    // v0 (legacy, pre-#3520): bare SHA256 over the raw ECDH product, no domain
    // separation. Kept ONLY for decrypting old-version blobs / legacy sessions.
    _deriveECDHSecretLegacy(privateKey, publicKey) {
        let raw = this._ecdhProduct(privateKey, publicKey);
        return crypto.createHash('sha256').update(raw).digest();
    }

    // v1 KDF: HKDF-SHA256 over the raw ECDH product with a fixed protocol salt
    // and a per-method `info` label. The differing `info` per method is what
    // guarantees cross-method domain separation (fix #3520).
    _hkdfFromEcdh(privateKey, publicKey, info) {
        let raw = this._ecdhProduct(privateKey, publicKey);
        return hkdfSha256(raw, HKDF_SALT, info, HKDF_KEY_LEN);
    }

    // Test-only handle on the module-private HKDF, so the suite can pin it
    // against Node's builtin on arbitrary salt/info/length vectors.
    _hkdfSha256Test(ikm, salt, info, length) {
        return hkdfSha256(ikm, salt, info, length);
    }

    // v1 ECIES key (info = xchain-ecies-v1)
    _deriveEciesKey(privateKey, publicKey) {
        return this._hkdfFromEcdh(privateKey, publicKey, HKDF_INFO_ECIES);
    }

    // v1 ECDH-session key (info = xchain-ecdh-session-v1)
    _deriveEcdhSessionKey(privateKey, publicKey) {
        return this._hkdfFromEcdh(privateKey, publicKey, HKDF_INFO_ECDH);
    }

    // Unpack a (possibly versioned) ECIES envelope and derive the matching key.
    //   v1: [0x01][ephemeralPubkey(33)][iv(12)][authTag(16)][encrypted] -> HKDF
    //   v0: [ephemeralPubkey(33)][iv(12)][authTag(16)][encrypted]       -> legacy SHA256
    // A compressed pubkey always starts with 0x02/0x03, so byte 0 == 0x01
    // unambiguously identifies a v1 blob.
    _unpackEcies(buf, recipientPrivateKey) {
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
            ? this._deriveEciesKey(recipientPrivateKey, ephemeralPubkey)
            : this._deriveECDHSecretLegacy(recipientPrivateKey, ephemeralPubkey);

        return { version, iv, authTag, encrypted, sharedSecret };
    }

    _aesEncrypt(plaintext, key) {
        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack: iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([iv, authTag, encrypted]);
        return { ciphertext: ciphertext.toString('hex') };
    }

    // Binary counterpart to _aesEncrypt: same envelope, no utf8 conversion.
    _aesEncryptBytes(plaintext, key) {
        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack: iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([iv, authTag, encrypted]);
        return { ciphertext: ciphertext.toString('hex') };
    }

    _aesDecrypt(ciphertext, key) {
        let { plaintext } = this._aesDecryptBytes(ciphertext, key);
        return { plaintext: plaintext.toString('utf8') };
    }

    // Binary counterpart to _aesDecrypt: returns the raw plaintext Buffer.
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
    }

    _normalizeKey(key) {
        if (!key)
            throw new SDKMessagingError('INVALID_KEY', 'Encryption key is required.');

        let buf = this._toBuffer(key, 'key');
        if (buf.length === 32) return buf;
        return crypto.createHash('sha256').update(buf).digest();
    }

    _toBuffer(value, name) {
        if (Buffer.isBuffer(value)) return value;
        if (typeof value === 'string') return Buffer.from(value, 'hex');
        throw new SDKMessagingError('INVALID_TYPE', `${name} must be a hex string or Buffer.`);
    }
}

module.exports = MessagingUtils;
