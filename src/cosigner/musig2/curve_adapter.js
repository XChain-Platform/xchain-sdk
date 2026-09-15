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
 * XChain Platform SDK - MuSig2 Curve Adapter
 *
 ********************************************************************/

const { MuSigFactory } = require('@brandonblack/musig');
const baseCrypto       = require('@brandonblack/musig/base_crypto');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { sha256 }       = require('@noble/hashes/sha2');
const { SDKMuSigError } = require('../../utils/errors.js');


const Point      = secp256k1.ProjectivePoint;
const schnorrUtl = schnorr.utils;


function concat(...parts) {
    let total = 0;
    for (let p of parts) total += p.length;
    let out = new Uint8Array(total);
    let off = 0;
    for (let p of parts) { out.set(p, off); off += p.length; }
    return out;
}


/*
 * Crypto adapter for the MuSig factory.
 *
 * Implements the 20-method `Crypto` interface expected by
 * @brandonblack/musig. Scalar ops + misc curve predicates come from
 * base_crypto (pure BigInt); secp256k1 point operations + hashing
 * come from @noble/curves + @noble/hashes.
 */
const ecc = {

    // Scalar ops and predicates from base_crypto
    scalarAdd:      baseCrypto.scalarAdd,
    scalarMultiply: baseCrypto.scalarMultiply,
    scalarNegate:   baseCrypto.scalarNegate,
    scalarMod:      baseCrypto.scalarMod,
    isScalar:       baseCrypto.isScalar,
    isSecret:       baseCrypto.isSecret,
    isPoint:        baseCrypto.isPoint,
    isXOnlyPoint:   baseCrypto.isXOnlyPoint,
    pointNegate:    baseCrypto.pointNegate,
    pointX:         baseCrypto.pointX,
    hasEvenY:       baseCrypto.hasEvenY,

    // Curve ops over @noble/curves/secp256k1

    // P + t*G, tweaked public key addition
    pointAddTweak(p, t, compressed) {
        try {
            let P = Point.fromHex(p);
            let tG = Point.BASE.multiply(baseCrypto.readSecret(t));
            let R = P.add(tG);
            return R.toRawBytes(compressed);
        } catch (e) {
            return null;
        }
    },

    // a + b (point addition)
    pointAdd(a, b, compressed) {
        try {
            let A = Point.fromHex(a);
            let B = Point.fromHex(b);
            let R = A.add(B);
            return R.toRawBytes(compressed);
        } catch (e) {
            return null;
        }
    },

    // a*P ("unsafe" in the sense that it accepts scalars that may be
    // zero; infinity returns null so the caller can branch).
    pointMultiplyUnsafe(p, a, compressed) {
        try {
            let scalar = baseCrypto.readScalar(a);
            if (scalar === 0n) return null;
            let P = Point.fromHex(p);
            let R = P.multiplyUnsafe(scalar);
            return R.toRawBytes(compressed);
        } catch (e) {
            return null;
        }
    },

    // a*P1 + P2
    pointMultiplyAndAddUnsafe(p1, a, p2, compressed) {
        try {
            let scalar = baseCrypto.readScalar(a);
            let P1 = Point.fromHex(p1);
            let P2 = Point.fromHex(p2);
            let aP1 = scalar === 0n ? Point.ZERO : P1.multiplyUnsafe(scalar);
            let R = aP1.add(P2);
            return R.toRawBytes(compressed);
        } catch (e) {
            return null;
        }
    },

    // compress/decompress a point
    pointCompress(p, compress = true) {
        let P = Point.fromHex(p);
        return P.toRawBytes(compress);
    },

    // BIP340 lift_x: convert a 32-byte x-only pubkey to a compressed pubkey
    liftX(x) {
        try {
            let xBig = baseCrypto.readSecret(x);
            let P = schnorrUtl.lift_x(xBig);
            let raw = P.toRawBytes(true);
            return raw;
        } catch (e) {
            return null;
        }
    },

    // derive pubkey from secret scalar
    getPublicKey(s, compressed) {
        try {
            let P = secp256k1.getPublicKey(s, compressed);
            return P;
        } catch (e) {
            return null;
        }
    },

    // BIP340 tagged hash
    taggedHash(tag, ...messages) {
        return schnorrUtl.taggedHash(tag, ...messages);
    },

    // plain sha256 of concatenated messages
    sha256(...messages) {
        return sha256(concat(...messages));
    },
};


// Single instance: required because the underlying library stashes
// secret nonces in an internal Map keyed by publicNonce. See module
// header.
const _musig = MuSigFactory(ecc);


/*
 * Validate a byte-sized input. Throws SDKMuSigError on failure.
 */
function requireBytes(v, label, expectedLen) {
    if (!(v instanceof Uint8Array))
        throw new SDKMuSigError('INVALID_INPUT', label + ' must be a Uint8Array');
    if (expectedLen !== undefined && v.length !== expectedLen)
        throw new SDKMuSigError('INVALID_INPUT',
            label + ' must be ' + expectedLen + ' bytes (got ' + v.length + ')');
}


/*
 * Convert an array of pubkeys: accept hex strings or Uint8Arrays,
 * normalize to Uint8Array[].
 */
function normalizePubkeys(pubkeys) {
    if (!Array.isArray(pubkeys) || pubkeys.length < 2)
        throw new SDKMuSigError('INVALID_INPUT',
            'publicKeys must be an array of at least 2 pubkeys');
    const keys = pubkeys.map((pk, i) => {
        if (typeof pk === 'string') return Buffer.from(pk, 'hex');
        if (pk instanceof Uint8Array) return pk;
        throw new SDKMuSigError('INVALID_INPUT',
            'publicKeys[' + i + '] must be hex string or Uint8Array');
    });
    // Reject repeated participants: a duplicate collapses the policy threshold,
    // since MuSig2([X,X]) aggregates to a key X alone can sign and a recovery
    // key equal to a hot key turns its leaf into a unilateral spending path.
    const seen = new Map();
    keys.forEach((k, i) => {
        const hex = Buffer.from(k).toString('hex').toLowerCase();
        if (seen.has(hex))
            throw new SDKMuSigError('INVALID_INPUT',
                'publicKeys must be pairwise distinct: entries '
                + seen.get(hex) + ' and ' + i + ' are the same key');
        seen.set(hex, i);
    });
    return keys;
}


module.exports = { concat, Point, schnorrUtl, ecc, _musig, requireBytes, normalizePubkeys };
