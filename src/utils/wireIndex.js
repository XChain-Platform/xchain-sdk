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
 * XChain Platform SDK - Exact Wire-Index Identity
 *
 * Shared helper for identity comparisons on the explorer's BIGINT-as-string
 * wire indices (action_index, block_index, tx_index). The v2 wire contract
 * serializes every BIGINT column as a decimal STRING on REST and WS alike
 * (xchain-explorer/src/ws/schema-version.js), and Number() collapses two
 * ADJACENT such indices onto one value above 2^53. A guard written with
 * Number() therefore matches the neighbour it exists to reject, which is
 * exactly the regression the explorer side already retired in _advanceCursor
 * (src/websocket.js) and ChangeDetector._nextCursor.
 *
 * Comparison only: this module deliberately does not re-type any value a
 * caller returns, so the SDK's published result shapes are unchanged.
 *
 ********************************************************************/

'use strict';

/*
 * Parse a wire index into a BigInt, or null when the value is not a usable
 * one. A JS number above Number.MAX_SAFE_INTEGER has ALREADY lost precision
 * before this module sees it, so it is not an index but a rounded artifact:
 * refusing it keeps a laundered value out of a comparison that would then
 * pass. Leading zeros and surrounding whitespace parse (Number() accepted
 * both), everything else does not.
 *
 * @param {*} v
 * @returns {bigint|null}
 */
function toWireIndex(v){
    if (typeof v === 'bigint') return (v >= 0n) ? v : null;
    if (typeof v === 'number') return (Number.isSafeInteger(v) && v >= 0) ? BigInt(v) : null;
    if (typeof v === 'string'){
        const s = v.trim();
        return /^[0-9]+$/.test(s) ? BigInt(s) : null;
    }
    return null;
}

/*
 * True only when both sides name the SAME non-negative wire index, comparing
 * as BigInt so two consecutive indices above 2^53 stay distinct. A string and
 * its numeric spelling agree ('2' matches 2), which is the coercion callers
 * relied on Number() for. An absent or unparseable value on either side is
 * false: every caller reads false as a mismatch, so garbage fails closed
 * instead of coercing its way into a match (Number(null) === 0 did match
 * index 0).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function sameWireIndex(a, b){
    const x = toWireIndex(a);
    if (x === null) return false;
    const y = toWireIndex(b);
    return y !== null && x === y;
}

module.exports = { toWireIndex, sameWireIndex };
