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
 * XChain Platform SDK - Message Rows
 *
 * Read-side helpers for getMessages: the explorer query shape and the
 * conversion of a raw message row into an inbox entry.
 *
 ********************************************************************/

const { METHOD_ECIES } = require('./kdf_constants.js');

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

module.exports = {
    messageQueryType,
    messagePaginationOpts,
    unwrapMessages,
    messageEntry
};
