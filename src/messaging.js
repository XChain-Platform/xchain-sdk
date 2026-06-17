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

    // -------------------------------------------------------------------------
    //  ECIES (Method 1): Address Communication
    // -------------------------------------------------------------------------

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

        // Generate ephemeral keypair
        let ephemeral = ECPair.makeRandom({ compressed: true });

        // Derive shared secret via ECDH
        let sharedSecret = this._deriveECDHSecret(ephemeral.privateKey, pubkeyBuf);

        // Encrypt with AES-256-GCM
        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack: ephemeralPubkey(33) + iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([ephemeral.publicKey, iv, authTag, encrypted]);

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

        if (ciphertextBuf.length < ECIES_OVERHEAD)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext too short to contain ECIES data.');

        let net = this._resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKMessagingError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        // Unpack
        let ephemeralPubkey = ciphertextBuf.subarray(0, EPHEMERAL_PUBKEY_LEN);
        let iv              = ciphertextBuf.subarray(EPHEMERAL_PUBKEY_LEN, EPHEMERAL_PUBKEY_LEN + IV_LEN);
        let authTag         = ciphertextBuf.subarray(EPHEMERAL_PUBKEY_LEN + IV_LEN, ECIES_OVERHEAD);
        let encrypted       = ciphertextBuf.subarray(ECIES_OVERHEAD);

        // Derive shared secret
        let sharedSecret = this._deriveECDHSecret(keyPair.privateKey, ephemeralPubkey);

        // Decrypt
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

        // Validate curve point (same guard as eciesEncrypt).
        if (!ecc.isPoint(pubkeyBuf))
            throw new SDKMessagingError('INVALID_PUBKEY', 'Recipient public key is not a valid secp256k1 point.');

        let ephemeral = ECPair.makeRandom({ compressed: true });
        let sharedSecret = this._deriveECDHSecret(ephemeral.privateKey, pubkeyBuf);

        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        let authTag = cipher.getAuthTag();

        let ciphertext = Buffer.concat([ephemeral.publicKey, iv, authTag, encrypted]);
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

        if (ciphertextBuf.length < ECIES_OVERHEAD)
            throw new SDKMessagingError('INVALID_CIPHERTEXT', 'Ciphertext too short to contain ECIES data.');

        let net = this._resolveNet();
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(wif, net);
        } catch (err) {
            throw new SDKMessagingError('INVALID_WIF', `Failed to import WIF: ${err.message}`);
        }

        let ephemeralPubkey = ciphertextBuf.subarray(0, EPHEMERAL_PUBKEY_LEN);
        let iv              = ciphertextBuf.subarray(EPHEMERAL_PUBKEY_LEN, EPHEMERAL_PUBKEY_LEN + IV_LEN);
        let authTag         = ciphertextBuf.subarray(EPHEMERAL_PUBKEY_LEN + IV_LEN, ECIES_OVERHEAD);
        let encrypted       = ciphertextBuf.subarray(ECIES_OVERHEAD);

        let sharedSecret = this._deriveECDHSecret(keyPair.privateKey, ephemeralPubkey);

        try {
            let decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
            decipher.setAuthTag(authTag);
            let plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return { plaintext };
        } catch (err) {
            throw new SDKMessagingError('DECRYPTION_FAILED', `ECIES decryption failed: ${err.message}`);
        }
    }

    // -------------------------------------------------------------------------
    //  ECDH (Method 2): Session Communication
    // -------------------------------------------------------------------------

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
     * @returns {{ sharedSecret: string }} - Hex-encoded 32-byte shared secret
     */
    deriveSharedSecret(wif, theirPublicKey) {
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

        let secret = this._deriveECDHSecret(keyPair.privateKey, pubkeyBuf);
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

    // -------------------------------------------------------------------------
    //  AES (Method 3): Shared Secret Communication
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    //  Public Key Lookup
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    //  High-Level Send
    // -------------------------------------------------------------------------

    /**
     * Send a message to a destination address.
     * Handles pubkey lookup, encryption, action creation, signing, and broadcasting.
     *
     * @param {Object} params
     * @param {string} params.wif - Sender's WIF private key
     * @param {string} params.coin - Destination coin network (BTC, LTC, DOGE)
     * @param {string} params.destination - Recipient address
     * @param {string|Buffer} params.message - Message content. A Buffer triggers binary
     *                                          ECIES (no utf8 conversion), used for
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
            if (messageIsBytes)
                throw new SDKMessagingError('INVALID_MESSAGE',
                    'ECDH (method=2) does not yet support binary payloads; pass a string message.');
            if (!params.sharedSecret)
                throw new SDKMessagingError('SHARED_SECRET_REQUIRED',
                    'Shared secret is required for ECDH encryption. Use deriveSharedSecret() first.');

            let result = this.sessionEncrypt(params.message, params.sharedSecret);
            // v2 has no ENCRYPTION_METHOD slot (see ECIES branch above); the ECDH
            // session is established out-of-band via v0/v1 key exchange, so the
            // method stays off the wire.
            actionParams.encryptedMessage = result.ciphertext;

        } else if (method === METHOD_AES) {
            // AES: requires a pre-shared key
            if (messageIsBytes)
                throw new SDKMessagingError('INVALID_MESSAGE',
                    'AES (method=3) does not yet support binary payloads; pass a string message.');
            if (!params.sharedKey)
                throw new SDKMessagingError('SHARED_KEY_REQUIRED',
                    'Shared key is required for AES encryption.');

            let result = this.aesEncrypt(params.message, params.sharedKey);
            // v2 has no ENCRYPTION_METHOD slot (see ECIES branch above); the AES
            // shared key is distributed out-of-band, so the method stays off the wire.
            actionParams.encryptedMessage = result.ciphertext;

        } else {
            throw new SDKMessagingError('INVALID_METHOD',
                `Invalid encryption method: ${method}. Use 1 (ECIES), 2 (ECDH), 3 (AES), or null (plaintext).`);
        }

        // Create the MESSAGE action and encode into PSBT
        let actionResult = await sdk.createAction({
            action: 'MESSAGE',
            params: actionParams,
            encoder: params.encoder
        });

        // Sign and broadcast
        let signed = sdk.wallet.signPsbt(actionResult.psbt, params.wif);
        let broadcast = await sdk.wallet.broadcastTx(signed.txHex, sdk._requireEncoder());

        return {
            txid: signed.txid,
            actionString: actionResult.actionString
        };
    }

    // -------------------------------------------------------------------------
    //  High-Level Receive / Read
    // -------------------------------------------------------------------------

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

        if (!rawMessages || !Array.isArray(rawMessages)) return [];

        let results = [];
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
                txid:      msg.tx_hash || null,
                block:     msg.block_index || null,
                timestamp: msg.block_time || null
            };

            if (msg.plaintext_message) {
                entry.text = msg.plaintext_message;
            } else if (msg.encrypted_message && opts.wif) {
                try {
                    if (method === METHOD_ECIES) {
                        // Decrypt to raw bytes so binary payloads (gated-content
                        // handoffs) survive intact, then surface the utf8 view
                        // for conversational callers.
                        let result = this.eciesDecryptBytes(msg.encrypted_message, opts.wif);
                        entry.bytes = result.plaintext;
                        entry.text  = result.plaintext.toString('utf8');
                    }
                    // ECDH and AES require the shared secret/key which we don't have here
                    // Those must be decrypted by the application
                } catch (err) {
                    // Decryption failed; leave text/bytes as null
                }
                entry.encrypted = true;
            } else if (msg.encrypted_message) {
                entry.encrypted = true;
            }

            results.push(entry);
        }

        return results;
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

        // Sort by block descending (newest first)
        allMessages.sort((a, b) => (b.block || 0) - (a.block || 0));

        return allMessages;
    }

    // -------------------------------------------------------------------------
    //  Internal helpers
    // -------------------------------------------------------------------------

    // Derive a 32-byte shared secret via ECDH on secp256k1
    _deriveECDHSecret(privateKey, publicKey) {
        let ecdh = crypto.createECDH('secp256k1');
        ecdh.setPrivateKey(privateKey);
        let raw = ecdh.computeSecret(publicKey);
        // Hash to get a uniform 32-byte key
        return crypto.createHash('sha256').update(raw).digest();
    }

    // AES-256-GCM encrypt (shared between ECDH session and AES methods)
    _aesEncrypt(plaintext, key) {
        let iv = crypto.randomBytes(IV_LEN);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        let authTag = cipher.getAuthTag();

        // Pack: iv(12) + authTag(16) + encrypted
        let ciphertext = Buffer.concat([iv, authTag, encrypted]);
        return { ciphertext: ciphertext.toString('hex') };
    }

    // AES-256-GCM decrypt
    _aesDecrypt(ciphertext, key) {
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
            let plaintext = decipher.update(encrypted) + decipher.final('utf8');
            return { plaintext };
        } catch (err) {
            throw new SDKMessagingError('DECRYPTION_FAILED', `Decryption failed: ${err.message}`);
        }
    }

    // Normalize a key to a 32-byte Buffer (hash if not already 32 bytes)
    _normalizeKey(key) {
        if (!key)
            throw new SDKMessagingError('INVALID_KEY', 'Encryption key is required.');

        let buf = this._toBuffer(key, 'key');
        if (buf.length === 32) return buf;
        // Hash to 32 bytes if not already the right length
        return crypto.createHash('sha256').update(buf).digest();
    }

    // Convert hex string or Buffer to Buffer
    _toBuffer(value, name) {
        if (Buffer.isBuffer(value)) return value;
        if (typeof value === 'string') return Buffer.from(value, 'hex');
        throw new SDKMessagingError('INVALID_TYPE', `${name} must be a hex string or Buffer.`);
    }
}

module.exports = MessagingUtils;
