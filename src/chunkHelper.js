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

// Vendored single source of truth: ./protocol/constants.js, which is a REORDERED
// SUBSET of xchain-documentation/protocol/constants.js in VALUE PARITY with it,
// not a byte-identical copy (uuid:0eb83c45) - it exports 33 of the canonical 59
// symbols and omits e.g. MAX_STANDARD_TX_WEIGHT, so no file diff guards this
// seam and a "restore byte identity" edit would be wrong. These are the SDK's
// single in-repo entry point (validator.js and psbtActionDecode.js import them
// from here); test/unit/protocolSizeCaps.test.js pins them to the canonical
// values so a one-sided bump fails locally.
const PROTO = require('./protocol/constants.js');
const MAX_ACTION_DATA_LENGTH      = PROTO.MAX_ACTION_DATA_LENGTH;
const MAX_DEPLOYCHUNK_PART_BYTES  = PROTO.MAX_DEPLOYCHUNK_PART_BYTES;
const MAX_DEPLOY_CHUNKS           = PROTO.MAX_DEPLOY_CHUNKS;
// Bytes added by the OP_PUSHDATA2 push prefix (1-byte opcode + 2-byte
// little-endian length) when a 256..65535-byte payload is compiled into the
// on-chain script. MAX_ACTION_DATA_LENGTH bounds the *compiled* push (payload
// + push prefix, measured WITHOUT the OP_RETURN opcode), matching the
// encoder's compiledPushSize() (byteLength + 3 for >255 bytes) and the
// decoder's compiledDataLength (dl<=75?dl+1:dl<=255?dl+2:dl+3). The only
// consumer is fitsSingleDeploy(), whose decisions matter near the 8192-byte
// cap where the prefix is always OP_PUSHDATA2, so +3 is the exact overhead
// there (a sub-256-byte payload trivially fits regardless of prefix class).
const OP_RETURN_PUSH_OVERHEAD     = PROTO.OP_RETURN_PUSH_OVERHEAD;

// sha256 hex of the UTF-8 source: the chunk-group id AND the integrity check.
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

// A field the caller actually supplied, as the wire would carry it. undefined,
// null and '' all mean "no field": the selector only reaches a staking format
// when one of the two staking fields is populated, and serialize() trims a
// trailing empty one back off.
function tailField(value) {
    if (value === undefined || value === null) return '';
    return String(value);
}

// The non-code part of the inline DEPLOY string, in the shape the format selector
// would pick for these opts.
//   v0: 'DEPLOY|0|<base64>|<gas>|<ctor...>'                     (formats.js DEPLOY 0)
//   v1: 'DEPLOY|1|<base64>|<gas>|<ctor>|<cooldown>|<slashDst>'  (formats.js DEPLOY 1)
// Either staking field being populated is what selects v1, so budgeting the v0
// shape for a stakeable deploy under-counts the tail by 2 pipes plus both field
// widths (a full address is ~40 bytes). That is the one direction that matters:
// it plans single-shot a deploy whose real action string is over the cap, and the
// encoder then refuses the transaction at create time with no hint that chunking
// was the fix. A trailing empty SLASH_DESTINATION is dropped here exactly as
// FormatSelector.serialize drops it, so the estimate cannot over-count either and
// push an otherwise-inline deploy into a chunked (multi-transaction, multi-fee)
// plan.
function deployOverhead(opts) {
    const gas      = String(opts.gasLimit || 0);
    const ctor     = ctorString(opts.constructorParams);
    const cooldown = tailField(opts.cooldownBlocks);
    const slashDst = tailField(opts.slashDestination);
    if (cooldown === '' && slashDst === '')
        return 'DEPLOY|0||' + gas + '|' + ctor;
    let tail = '|' + cooldown;
    if (slashDst !== '') tail += '|' + slashDst;
    return 'DEPLOY|1||' + gas + '|' + ctor + tail;
}

// Whether base64(code) fits a single inline DEPLOY action under the compiled cap.
// Budget the non-code overhead (+ the OP_PUSHDATA2 prefix) and compare against
// the cap. Pass cooldownBlocks/slashDestination for a stakeable deploy, or the
// estimate sizes a v0 action the wire will not carry.
function fitsSingleDeploy(code, opts = {}) {
    let b64      = Buffer.from(String(code), 'utf8').toString('base64');
    let overhead = deployOverhead(opts).length + OP_RETURN_PUSH_OVERHEAD;
    return (Buffer.byteLength(b64, 'utf8') + overhead) <= MAX_ACTION_DATA_LENGTH;
}

// Split base64(code) into ordered slices each <= MAX_DEPLOYCHUNK_PART_BYTES bytes.
// The slices are of the base64 STRING (not the raw bytes), so plain concatenation
// in order restores base64(code) exactly; no 4-char alignment is required.
function splitCode(code) {
    let b64   = Buffer.from(String(code), 'utf8').toString('base64');
    let parts = [];
    for (let i = 0; i < b64.length; i += MAX_DEPLOYCHUNK_PART_BYTES)
        parts.push(b64.slice(i, i + MAX_DEPLOYCHUNK_PART_BYTES));
    if (parts.length === 0) parts.push(''); // empty source: one empty slice (edge)
    return parts;
}

// Plan a deploy: { codeHash, single, parts, totalChunks }. `single` true => deploy
// inline (DEPLOY v0/v1); false => submit `parts` as DEPLOY v4 carriers then assemble via
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
    MAX_DEPLOY_CHUNKS,
    OP_RETURN_PUSH_OVERHEAD
};
