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
 * XChain Platform SDK - Constant-Time Token Comparison
 *
 * Shared helper for bearer-token auth gates (cosigner/server.js, api.js).
 * A plain `!==` string compare leaks token length/prefix timing to a
 * network attacker; crypto.timingSafeEqual alone still leaks length when
 * the two buffers differ in size (it throws before comparing). Hashing
 * both sides first equalizes operand length, so the same pattern already
 * used at cosigner/client.js and x402.js (length-check + timingSafeEqual)
 * applies uniformly regardless of the raw token lengths.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Per-process HMAC key for the length-equalizing digests below. Generated at
// load and never exported: both operands of a comparison are always keyed with
// it in the same call, so it needs no persistence across processes.
const COMPARE_KEY = crypto.randomBytes(32);

/*
 * Constant-time-ish comparison of two candidate secrets. Returns false
 * (never throws) when either input is not a non-empty string.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function safeTokenEqual(a, b) {
    if (typeof a !== 'string' || a.length === 0) return false;
    if (typeof b !== 'string' || b.length === 0) return false;
    // Keyed digests, not bare hashes: both sides are reduced to a fixed 32 bytes
    // so timingSafeEqual can run at all (it throws on length mismatch, and the
    // mismatch itself would leak the length). The key is random per process and
    // never leaves it, so an attacker cannot precompute a digest to compare
    // against, which a bare unsalted hash of the candidate would allow.
    // Not password storage, so no work factor applies: neither digest is
    // persisted or transmitted, and both are recomputed per comparison. A
    // deliberately slow KDF here would only add latency to every authenticated
    // request while changing nothing an attacker can reach.
    const ha = crypto.createHmac('sha256', COMPARE_KEY).update(a).digest(); // codeql[js/insufficient-password-hash]
    const hb = crypto.createHmac('sha256', COMPARE_KEY).update(b).digest(); // codeql[js/insufficient-password-hash]
    return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeTokenEqual };
