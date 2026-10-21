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
 * Byte checks that accept a plain Uint8Array as well as a Buffer.
 *
 * bitcoinjs-lib 7 (and the ecc and key libraries beside it) return plain
 * Uint8Array from address.toOutputScript, script.compile/decompile, payments
 * and Psbt parsing. apply_bufferutils_patch converts those to Buffer, but only
 * in a process that loaded it; a consumer that deep-requires the co-signer,
 * carrier or decoder modules does not. Buffer.isBuffer(Uint8Array) is false,
 * Uint8Array has no .equals, and its .toString('hex') returns "1,2,3" with no
 * error, so every check on a library value goes through these instead.
 *
 ********************************************************************/

'use strict';

// True for a Buffer or any other Uint8Array (a Buffer is a Uint8Array).
function isBytes(x) {
    return x instanceof Uint8Array;
}

// The same bytes as a Buffer, without copying when it already is one. Shares
// memory with a plain Uint8Array, so callers that mutate must copy first.
function toBuffer(x) {
    if (Buffer.isBuffer(x)) return x;
    return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
}

// Byte equality for any two Uint8Arrays; false when either side is not bytes.
function bytesEqual(a, b) {
    if (!isBytes(a) || !isBytes(b)) return false;
    return Buffer.compare(a, b) === 0;
}

// Lowercase hex of any Uint8Array.
function toHex(x) {
    return toBuffer(x).toString('hex');
}

module.exports = { isBytes, toBuffer, bytesEqual, toHex };
