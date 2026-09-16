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

const crypto = require('crypto');
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');
const { SDKMessagingError } = require('../../utils/errors.js');

const ECPair = ECPairFactory(ecc);

// ECIES ciphertext layout:
// [ephemeralPubkey (33 bytes)] [iv (12 bytes)] [authTag (16 bytes)] [encrypted data]
const EPHEMERAL_PUBKEY_LEN = 33;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const ECIES_OVERHEAD = EPHEMERAL_PUBKEY_LEN + IV_LEN + AUTH_TAG_LEN;

// Encryption method constants
const METHOD_ECIES = 1;
const METHOD_ECDH  = 2;
const METHOD_AES   = 3;

// Cap on distinct counterparty pubkey lookups per getMessages() sweep. Every
// cache miss in the ECDH fallback is an explorer round-trip, so an inbox
// stuffed with undecryptable messages from unique senders would otherwise fan
// out one network request per sender. Once the budget is spent the sweep stops
// resolving new counterparties and leaves those rows encrypted; callers that
// genuinely need a wider sweep raise it with opts.maxPubkeyLookups.
const ECDH_MAX_PUBKEY_LOOKUPS = 25;

//  ECDH key-derivation versioning.
//
//  Legacy (v0) derivation was a bare SHA256(raw_ecdh_product) with no HKDF and
//  no domain separation: the SAME raw ECDH product produced the SAME AES key
//  regardless of which method (ECIES vs ECDH-session) consumed it. v1 replaces
//  this with HKDF-SHA256 and a per-method `info` label so the two methods can
//  never collide, even with an identical ECDH product.
//
//  Envelope versioning (ECIES only): the ECIES ciphertext is framed as
//    [ephemeralPubkey(33)] [iv(12)] [authTag(16)] [encrypted]
//  A compressed secp256k1 pubkey ALWAYS begins with 0x02 or 0x03, so a v0 blob
//  never starts with any other byte. v1 blobs therefore prepend a single
//  version byte (KDF_VERSION_V1 = 0x01) which is unambiguous against 0x02/0x03.
//  On decrypt we sniff byte 0: 0x01 -> v1 (HKDF), 0x02/0x03 -> v0 (legacy SHA256).
//
//  ECDH-session (deriveSharedSecret) returns a RAW 32-byte secret with no
//  envelope to version. Pre-launch, sessions are short-lived and established
//  out-of-band, so deriveSharedSecret() derives the v1 HKDF secret by
//  default; the legacy secret stays reachable via the `legacy` option for any
//  pre-existing session that must still interoperate.
const KDF_VERSION_V0 = 0;       // bare SHA256(raw ecdh product), no domain sep
const KDF_VERSION_V1 = 1;       // HKDF-SHA256 with per-method info label

// Fixed protocol-domain salt for HKDF. A constant (non-secret) salt is the
// standard HKDF choice when no high-entropy salt is available; domain
// separation is carried by the per-method `info` label below. The bytes are
// the ASCII of "xchain-messaging-kdf-v1".
const HKDF_SALT = Buffer.from('xchain-messaging-kdf-v1', 'utf8');

// Per-method HKDF `info` labels. These MUST differ so an identical ECDH
// product can never derive the same key across methods.
const HKDF_INFO_ECIES = Buffer.from('xchain-ecies-v1', 'utf8');
const HKDF_INFO_ECDH  = Buffer.from('xchain-ecdh-session-v1', 'utf8');

const HKDF_KEY_LEN = 32;        // AES-256 key

/**
 * HKDF-SHA256 (RFC 5869), extract-then-expand.
 *
 * Node's `crypto.hkdfSync` does the same thing, but it does NOT exist in the
 * browser crypto shims the wallet's web / extension / desktop-renderer shells
 * build against, where it throws "crypto2.hkdfSync is not a function". That
 * killed every v1 encrypt AND decrypt in a browser - which is the whole
 * messaging feature outside Node. HMAC-SHA256 is present in those
 * shims, so the two RFC 5869 steps are done here instead: extract a PRK with
 * the salt as the HMAC key, then expand it one 32-byte block at a time.
 *
 * The output is byte-identical to `crypto.hkdfSync('sha256', ...)`; a unit
 * test pins that equality against the builtin wherever the builtin exists, so
 * a browser-derived key and a Node-derived key can never diverge - they have
 * to agree, or a message encrypted in one cannot be read in the other.
 *
 * @param {Buffer} ikm    input keying material (the raw ECDH product)
 * @param {Buffer} salt   protocol salt
 * @param {Buffer} info   per-method domain-separation label
 * @param {number} length bytes of key material to produce
 * @returns {Buffer}
 */
function hkdfSha256(ikm, salt, info, length) {
    // Extract: PRK = HMAC(salt, ikm). RFC 5869 defines an all-zero salt of
    // hash length when none is given; ours is always supplied.
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    // Expand: T(n) = HMAC(PRK, T(n-1) || info || n), concatenated and truncated.
    const blocks = Math.ceil(length / 32);
    if (blocks > 255) throw new SDKMessagingError('hkdfSha256: requested length exceeds RFC 5869 maximum');
    let prev = Buffer.alloc(0);
    const out = [];
    for (let i = 1; i <= blocks; i++) {
        prev = crypto.createHmac('sha256', prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest();
        out.push(prev);
    }
    return Buffer.concat(out).subarray(0, length);
}

/**
 * Resolve a caller-supplied ECDH pubkey-lookup budget to a usable count.
 * 0 disables the ECDH fallback's network lookups entirely and Infinity opts
 * out of the cap; anything not a non-negative number falls back to the default
 * so a bad option can never widen the budget.
 *
 * @param {*} value  opts.maxPubkeyLookups as supplied by the caller
 * @returns {number}
 */
function normalizeLookupBudget(value) {
    if (value === undefined || value === null) return ECDH_MAX_PUBKEY_LOOKUPS;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) return ECDH_MAX_PUBKEY_LOOKUPS;
    return Math.floor(value);   // Infinity floors to Infinity, so "no cap" survives
}

module.exports = {
    ECPair,
    EPHEMERAL_PUBKEY_LEN,
    IV_LEN,
    AUTH_TAG_LEN,
    ECIES_OVERHEAD,
    METHOD_ECIES,
    METHOD_ECDH,
    METHOD_AES,
    KDF_VERSION_V0,
    KDF_VERSION_V1,
    HKDF_SALT,
    HKDF_INFO_ECIES,
    HKDF_INFO_ECDH,
    HKDF_KEY_LEN,
    hkdfSha256,
    normalizeLookupBudget
};
