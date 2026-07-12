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
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeTokenEqual };
