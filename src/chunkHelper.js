/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain SDK - Chunked DEPLOY helper
 *
 * A contract whose base64-encoded source does not fit a single DEPLOY action
 * (the compiled-action cap is MAX_ACTION_DATA_LENGTH) is deployed in two phases:
 *   1. one DEPLOY v4 carrier action per ordered base64 slice, and
 *   2. an assembling DEPLOY v2/v3 carrying the CODE_HASH (sha256 of the source).
 * The indexer reassembles the slices, sha256-verifies them against CODE_HASH,
 * and runs the normal deploy flow. This module decides single-shot vs chunked
 * and produces the deterministic slices + hash.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Canonical values: xchain-documentation/protocol/constants.js. Kept in lockstep
// with the indexer + decoder by the cross-service regression suite.
const MAX_ACTION_DATA_LENGTH      = 8192;
const MAX_DEPLOYCHUNK_PART_BYTES  = 7800;
const MAX_DEPLOY_CHUNKS           = 16;
const OP_RETURN_PUSH_OVERHEAD     = 3;

// sha256 hex of the UTF-8 source — the chunk-group id AND the integrity check.
// Matches the indexer's crypto.createHash('sha256').update(code) (utf8 default).
function codeHashOf(code) {
    return crypto.createHash('sha256').update(Buffer.from(String(code), 'utf8')).digest('hex');
}

// Normalize constructorParams (array | string | undefined) into a pipe-joined string
// for the single-shot size estimate (mirrors how the wire serializes the rest field).
function ctorString(constructorParams) {
    if (constructorParams === undefined || constructorParams === null) return '';
    let arr = Array.isArray(constructorParams) ? constructorParams : [constructorParams];
    return arr.map(p => String(p)).join('|');
}

// Whether base64(code) fits a single inline DEPLOY action under the compiled cap.
// The inline DEPLOY string is 'DEPLOY|<ver>|<base64>|<gas>|<ctor...>'; budget the
// non-code overhead (+ the OP_PUSHDATA2 prefix) and compare against the cap.
function fitsSingleDeploy(code, opts = {}) {
    let b64      = Buffer.from(String(code), 'utf8').toString('base64');
    let overhead = ('DEPLOY|0||' + String(opts.gasLimit || 0) + '|' + ctorString(opts.constructorParams)).length + OP_RETURN_PUSH_OVERHEAD;
    return (Buffer.byteLength(b64, 'utf8') + overhead) <= MAX_ACTION_DATA_LENGTH;
}

// Split base64(code) into ordered slices each ≤ MAX_DEPLOYCHUNK_PART_BYTES bytes.
// The slices are of the base64 STRING (not the raw bytes), so plain concatenation
// in order restores base64(code) exactly — no 4-char alignment is required.
function splitCode(code) {
    let b64   = Buffer.from(String(code), 'utf8').toString('base64');
    let parts = [];
    for (let i = 0; i < b64.length; i += MAX_DEPLOYCHUNK_PART_BYTES)
        parts.push(b64.slice(i, i + MAX_DEPLOYCHUNK_PART_BYTES));
    if (parts.length === 0) parts.push(''); // empty source → one empty slice (edge)
    return parts;
}

// Plan a deploy: { codeHash, single, parts, totalChunks }. `single` true ⇒ deploy
// inline (DEPLOY v0/v1); false ⇒ submit `parts` as DEPLOY v4 carriers then assemble via
// DEPLOY v2/v3. Throws if the code needs more than MAX_DEPLOY_CHUNKS slices.
function planDeploy(code, opts = {}) {
    let codeHash = codeHashOf(code);
    if (fitsSingleDeploy(code, opts))
        return { codeHash, single: true, parts: null, totalChunks: 0 };
    let parts = splitCode(code);
    if (parts.length > MAX_DEPLOY_CHUNKS)
        throw new Error('Contract source needs ' + parts.length + ' chunks, exceeds MAX_DEPLOY_CHUNKS (' + MAX_DEPLOY_CHUNKS + ')');
    return { codeHash, single: false, parts, totalChunks: parts.length };
}

module.exports = {
    codeHashOf,
    fitsSingleDeploy,
    splitCode,
    planDeploy,
    MAX_ACTION_DATA_LENGTH,
    MAX_DEPLOYCHUNK_PART_BYTES,
    MAX_DEPLOY_CHUNKS
};
