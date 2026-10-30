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
 * In-process BigInt-safe 64-bit value patch for bitcoinjs-lib.
 *
 * package.json pins bitcoinjs-lib 7, which uses BigInt satoshi values and
 * Uint8Array byte values. The v7 part preserves the Number and
 * Buffer-facing API while retaining exact unsigned 64-bit values above
 * 2^53-1. Dogecoin has no supply cap, so a single output can legitimately
 * exceed 2^53 sats (>~90.07M DOGE). The v6 part is an SDK-only fallback for
 * a forced bitcoinjs-lib 6 install, where the stock serializers (and
 * bip174's copy for the PSBT witnessUtxo field) throw above 2^53-1 and
 * types.Satoshi caps addOutput at 21M BTC; every block in it is gated off
 * under bitcoinjs-lib 7.
 *
 * This is the WRITE-SIDE contract, shared with
 * xchain-encoder/src/build/apply_bufferutils_patch.js: the patch teaches the loaded
 * modules to carry a satoshi value as either a Number (unchanged fast path)
 * or a BigInt up to 2^64-1 (the wire format's true ceiling). Readers return
 * a Number whenever the value is exactly representable and a BigInt only
 * above 2^53-1, so existing Number-based callers see identical behavior for
 * every value they could already handle. The READ-SIDE copies
 * (xchain-decoder/src/chain/apply_bufferutils_patch.js and
 * xchain-utxo-tracker/src/chain/apply_bufferutils_patch.js)
 * lift the same 2^53 wall for block decode but deliberately implement a
 * DIFFERENT contract: BufferReader.readUInt64 always returns a BigInt and
 * the module-level readUInt64LE/writeUInt64LE helpers keep the stock 2^53-1
 * ceiling. Only the 2^53 probe and the error strings are common to both.
 *
 * Re-sync seam (uuid:311476c7).
 * xchain-encoder/test/unit/build/apply_bufferutils_patch.test.js pins
 * compat.js, u64.js, v7.js and version.js byte-identical to the encoder's,
 * and pins the code below this banner identical to the encoder entry body
 * except for the one SDK-only require of the v6 part. v6.js has no encoder
 * twin and no guard.
 * Convergence runs SDK-ward: change this copy first, then copy the shared
 * parts to the encoder, or the twin guard goes red.
 *
 * All bitcoinjs-lib/bip174 consumers hold the patched modules' exports
 * objects and class prototypes rather than destructured copies, so
 * mutating them here retrofits every current and future caller.
 *
 ********************************************************************/

require('./apply_bufferutils_patch/v7')
require('./apply_bufferutils_patch/v6')

module.exports = require('bitcoinjs-lib/src/bufferutils')
