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
const { METHOD_ECIES, METHOD_ECDH, METHOD_AES, normalizeLookupBudget } = require('./kdf_constants.js');

function validateSendParams(params, sdk) {
    if (!params.wif || typeof params.wif !== 'string')
        throw new SDKMessagingError('INVALID_WIF', 'WIF private key is required.');
    if (!params.coin || typeof params.coin !== 'string')
        throw new SDKMessagingError('INVALID_COIN', 'Destination coin is required (BTC, LTC, DOGE).');
    if (!params.destination || typeof params.destination !== 'string')
        throw new SDKMessagingError('INVALID_DESTINATION', 'Destination address is required.');
    const messageIsBytes = Buffer.isBuffer(params.message);
    if (params.message === undefined || params.message === null
        || (!messageIsBytes && typeof params.message !== 'string')
        || (typeof params.message === 'string' && params.message.length === 0)
        || (messageIsBytes && params.message.length === 0))
        throw new SDKMessagingError('INVALID_MESSAGE', 'Message is required (string or Buffer).');
    if (!params.encoder)
        throw new SDKMessagingError('ENCODER_REQUIRED', 'Encoder options are required.');
    if (!sdk)
        throw new SDKMessagingError('SDK_REQUIRED', 'SDK instance is required. Use sdk.sendMessage() instead.');
    return messageIsBytes;
}

async function encryptEcies(owner, params, sdk, messageIsBytes) {
    // ECIES: look up recipient pubkey and encrypt
    const explorer = sdk.requireExplorer();
    const recipientPubkey = await owner.getPublicKey(params.destination, explorer);
    if (!recipientPubkey)
        throw new SDKMessagingError('PUBKEY_NOT_FOUND',
            `No public key found for ${params.destination}. The address may not have sent any XChain transactions yet.`);

    const result = messageIsBytes
        ? owner.eciesEncryptBytes(params.message, recipientPubkey)
        : owner.eciesEncrypt(params.message, recipientPubkey);
    // MESSAGE v2 (VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE) carries no
    // ENCRYPTION_METHOD on the wire; absence implies ECIES (1) by protocol.
    // Setting encryptionMethod here would add a field with no v2 slot and the
    // format selector would reject every version (NO_MATCHING_FORMAT), so the
    // method is deliberately kept off actionParams.
    return result.ciphertext;
}

function encryptEcdh(owner, params, messageIsBytes) {
    // ECDH: requires a pre-derived shared secret
    if (!params.sharedSecret)
        throw new SDKMessagingError('SHARED_SECRET_REQUIRED',
            'Shared secret is required for ECDH encryption. Use deriveSharedSecret() first.');

    const result = messageIsBytes
        ? owner.sessionEncryptBytes(params.message, params.sharedSecret)
        : owner.sessionEncrypt(params.message, params.sharedSecret);
    // v2 has no ENCRYPTION_METHOD slot (see ECIES branch above); the ECDH
    // session is established out-of-band via v0/v1 key exchange, so the
    // method stays off the wire.
    return result.ciphertext;
}

function encryptAes(owner, params, messageIsBytes) {
    // AES: requires a pre-shared key
    if (!params.sharedKey)
        throw new SDKMessagingError('SHARED_KEY_REQUIRED',
            'Shared key is required for AES encryption.');

    const result = messageIsBytes
        ? owner.aesEncryptBytes(params.message, params.sharedKey)
        : owner.aesEncrypt(params.message, params.sharedKey);
    // v2 has no ENCRYPTION_METHOD slot (see ECIES branch above); the AES
    // shared key is distributed out-of-band, so the method stays off the wire.
    return result.ciphertext;
}

async function buildMessageActionParams(owner, params, sdk, messageIsBytes) {
    const method = params.method !== undefined ? params.method : METHOD_ECIES;
    const actionParams = { coin: params.coin.toUpperCase(), destination: params.destination };
    if (method === null) {
        // Plaintext (format 3): binary payloads cannot be sent unencrypted
        if (messageIsBytes)
            throw new SDKMessagingError('INVALID_MESSAGE',
                'Plaintext (method=null) requires a string message; binary payloads must be encrypted.');
        actionParams.plaintextMessage = params.message;
    } else if (method === METHOD_ECIES) {
        actionParams.encryptedMessage = await encryptEcies(owner, params, sdk, messageIsBytes);
    } else if (method === METHOD_ECDH) {
        actionParams.encryptedMessage = encryptEcdh(owner, params, messageIsBytes);
    } else if (method === METHOD_AES) {
        actionParams.encryptedMessage = encryptAes(owner, params, messageIsBytes);
    } else {
        throw new SDKMessagingError('INVALID_METHOD',
            `Invalid encryption method: ${method}. Use 1 (ECIES), 2 (ECDH), 3 (AES), or null (plaintext).`);
    }
    return actionParams;
}

function messageQueryType(type) {
    if (type === 'sent') return 'source';
    if (type === 'received') return 'destination';
    return 'address';
}

function messagePaginationOpts(opts) {
    const paginationOpts = {};
    if (opts.limit !== undefined) paginationOpts.limit = opts.limit;
    if (opts.page !== undefined) paginationOpts.page = opts.page;
    if (opts.sortorder !== undefined) paginationOpts.sortorder = opts.sortorder;
    return paginationOpts;
}

function unwrapMessages(rawMessages) {
    // The explorer serves every list endpoint as `{ data: [...], total }`,
    // and `get` hands that body back untouched. Requiring a bare array here
    // meant a real explorer response always failed the check and the inbox
    // returned EMPTY - so a MESSAGE that is on-chain, valid and addressed to
    // you was invisible in the wallet, silently. Accept both shapes:
    // a bare array is what the unit-test doubles return.
    if (rawMessages && !Array.isArray(rawMessages) && Array.isArray(rawMessages.data))
        return rawMessages.data;
    return rawMessages;
}

function messageEntry(msg, opts) {
    let method = msg.encryption_method ? Number(msg.encryption_method) : null;
    if (method === null && msg.encrypted_message) method = METHOD_ECIES;
    return {
        from: msg.source || null, to: msg.destination || null,
        coin: msg.coin || null, chain: opts._chain || null,
        text: null, bytes: null, encrypted: false, method,
        // The counterparty's published pubkey + the wire format, surfaced
        // so handshake-aware callers can read format-0/1 key-exchange rows
        // (encryption_key) that getMessages otherwise drops.
        encryptionKey: msg.encryption_key || null,
        format: (msg.action_format === undefined || msg.action_format === null)
            ? null : Number(msg.action_format),
        txid: msg.tx_hash || null,
        block: msg.block_index || null,
        // The explorer /messages contract projects the block time as
        // `timestamp` (db.js: `b1.block_time as timestamp`); accept the
        // raw column name too for any non-explorer row source.
        timestamp: msg.timestamp || msg.block_time || null
    };
}

async function decryptMessageEntry(owner, entry, msg, address, opts, explorer, pubkeyCache) {
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
            const result = owner.eciesDecryptBytes(msg.encrypted_message, opts.wif);
            entry.bytes = result.plaintext;
            entry.text = result.plaintext.toString('utf8');
        } catch (err) {
            // Not an ECIES message for us; the ECDH fallback runs below.
        }
        if (entry.text === null) {
            const plaintext = await owner.tryEcdhDecrypt(msg, address, opts.wif, explorer, pubkeyCache);
            if (plaintext !== null) {
                entry.bytes = plaintext;
                entry.text = plaintext.toString('utf8');
                entry.method = METHOD_ECDH;  // correct the stamped-as-ECIES label
            }
        }
        // AES (method 3) needs an out-of-band shared key we don't have;
        // those stay encrypted with text=null.
        entry.encrypted = true;
    } else if (msg.encrypted_message) {
        entry.encrypted = true;
    }
    return entry;
}

module.exports = {
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
        const messageIsBytes = validateSendParams(params, sdk);
        const actionParams = await buildMessageActionParams(this, params, sdk, messageIsBytes);

        let actionResult = await sdk.createAction({
            action: 'MESSAGE',
            params: actionParams,
            encoder: params.encoder
        });

        let signed = sdk.wallet.signPsbt(actionResult.psbt, params.wif);
        let broadcast = await sdk.wallet.broadcastTx(signed.txHex, sdk.requireEncoder());

        return {
            txid: signed.txid,
            actionString: actionResult.actionString
        };
    },

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

        const type = opts.type || 'all';
        const queryType = messageQueryType(type);
        const paginationOpts = messagePaginationOpts(opts);
        const rawMessages = unwrapMessages(await explorer.getMessages(address, queryType, paginationOpts));

        if (!rawMessages || !Array.isArray(rawMessages)) return [];

        const results = [];
        // Per-call pubkey resolution state for the ECDH fallback. `cache` maps
        // counterparty address -> resolved pubkey (null included, so an
        // unresolvable sender costs one lookup no matter how many messages it
        // sent), and `remaining` is the network-lookup budget for cache misses.
        const pubkeyCache = {
            cache: new Map(),
            remaining: normalizeLookupBudget(opts.maxPubkeyLookups)
        };
        for (const msg of rawMessages) {
            // MESSAGE v2 carries no ENCRYPTION_METHOD on the wire; absence implies
            // ECIES (1) by protocol. The indexer stamps 1 for v2 rows, but legacy
            // rows (indexed before that change) may still carry a null method, so
            // infer ECIES here whenever an encrypted body is present without a method.
            const entry = messageEntry(msg, opts);
            results.push(await decryptMessageEntry(this, entry, msg, address, opts, explorer, pubkeyCache));
        }

        return results;
    },

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
    async tryEcdhDecrypt(msg, address, wif, explorer, pubkeyCache) {
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
    },

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
};
