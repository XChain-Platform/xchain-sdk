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
 * XChain Platform SDK - Wallet callback store
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

const NONCE_MODES = new Set(['same-device', 'cross-device']);

function createMemoryCallbackStore({ now = Date.now, nonceTtlMs = 600000, maxEntries = 2000 } = {}) {
    const nonces = new Map();
    const records = new Map();

    function pruneExpired(entries, time) {
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= time) entries.delete(key);
        }
    }

    return {
        issueNonce(mode) {
            if (!NONCE_MODES.has(mode)) {
                throw new TypeError('mode must be same-device or cross-device');
            }

            const time = now();
            pruneExpired(nonces, time);

            let nonce;
            do {
                nonce = crypto.randomBytes(16).toString('base64url');
            } while (nonces.has(nonce));

            nonces.set(nonce, { mode, expiresAt: time + nonceTtlMs });
            return nonce;
        },

        takeNonce(nonce) {
            const entry = nonces.get(nonce);
            if (!entry) return null;

            nonces.delete(nonce);
            if (entry.expiresAt <= now()) return null;
            return { mode: entry.mode };
        },

        put(id, rec) {
            const time = now();
            pruneExpired(records, time);

            records.delete(id);
            records.set(id, { rec, expiresAt: time + nonceTtlMs });
            while (records.size > maxEntries) {
                records.delete(records.keys().next().value);
            }
        },

        get(id) {
            const entry = records.get(id);
            if (!entry) return null;
            if (entry.expiresAt <= now()) {
                records.delete(id);
                return null;
            }
            return entry.rec;
        },
    };
}

module.exports = { createMemoryCallbackStore };
