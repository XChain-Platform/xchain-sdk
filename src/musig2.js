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
 * XChain Platform SDK - MuSig2 Primitives (BIP327)
 *
 * Key aggregation, nonce generation, partial signing, and signature
 * aggregation for MuSig2 — used by Taproot-MuSig2 multisig wallets.
 *
 * MuSig2-aggregated signatures are indistinguishable from single-sig
 * Schnorr signatures on chain: the VM / decoder / indexer / explorer
 * see a single Schnorr sig under a P2TR output.
 *
 * Wraps @brandonblack/musig (BitGo's production dependency via
 * @bitgo/secp256k1) with a Crypto adapter built from @noble/curves +
 * @noble/hashes + @brandonblack/musig/base_crypto.
 *
 * IMPORTANT: nonce generation and partial signing must happen on the
 * same module instance. The underlying library uses an internal
 * nonce cache keyed by publicNonce; a publicNonce generated on one
 * process cannot be partially-signed on another without also
 * transferring the secret nonce — which intentionally is not
 * exposed by this module. Cross-process signing requires the
 * deterministicSign flow (not yet wrapped).
 *
 ********************************************************************/

const { MuSigFactory } = require('@brandonblack/musig');
const baseCrypto       = require('@brandonblack/musig/base_crypto');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const { sha256 }       = require('@noble/hashes/sha2');
const { SDKMuSigError } = require('./errors.js');


const Point      = secp256k1.ProjectivePoint;
const schnorrUtl = schnorr.utils;


/*
 * Concatenate Uint8Arrays into one buffer (sha256 / taggedHash helpers)
 */
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

    // --- Scalar ops and predicates from base_crypto ---
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

    // --- Curve ops over @noble/curves/secp256k1 ---

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

    // a*P — "unsafe" in the sense that it accepts scalars that may be
    // zero; infinity returns null so the caller can branch.
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
    return pubkeys.map((pk, i) => {
        if (typeof pk === 'string') return Buffer.from(pk, 'hex');
        if (pk instanceof Uint8Array) return pk;
        throw new SDKMuSigError('INVALID_INPUT',
            'publicKeys[' + i + '] must be hex string or Uint8Array');
    });
}


/*
 * MuSig2 SDK wrapper.
 *
 * Exposes the 5 core primitives specified in Phase 4 Step 1:
 *   - aggregateKeys
 *   - generateNonce
 *   - aggregateNonces
 *   - partialSign
 *   - aggregateSignatures
 * Plus session helpers (startSession, verifyPartial) used across
 * partialSign and aggregateSignatures.
 */
class MuSig2 {

    /*
     * Aggregate N public keys into a single MuSig2 context.
     *
     * @param {(Uint8Array|string)[]} publicKeys  — 33-byte compressed pubkeys
     * @param {Uint8Array[]} [tweaks]             — optional post-aggregation tweaks
     * @returns {object} KeyGenContext:
     *   {
     *     aggPublicKey: Uint8Array(33),  — compressed aggregated pubkey
     *     xOnlyPubkey:  Uint8Array(32),  — x-only form for Taproot
     *     gacc: Uint8Array(32),
     *     tacc: Uint8Array(32)
     *   }
     */
    aggregateKeys(publicKeys, tweaks) {
        let keys = normalizePubkeys(publicKeys);
        let ctx;
        try {
            ctx = tweaks && tweaks.length > 0
                ? _musig.keyAgg(keys, ...tweaks)
                : _musig.keyAgg(keys);
        } catch (e) {
            throw new SDKMuSigError('KEY_AGG_FAILED', e.message);
        }
        return {
            aggPublicKey: ctx.aggPublicKey,
            xOnlyPubkey:  ecc.pointX(ctx.aggPublicKey),
            gacc:         ctx.gacc,
            tacc:         ctx.tacc,
        };
    }

    /*
     * BIP327 key-sorting helper. Returns the pubkeys in canonical order.
     */
    sortKeys(publicKeys) {
        return _musig.keySort(normalizePubkeys(publicKeys));
    }

    /*
     * Generate a MuSig2 nonce (round 1).
     *
     * @param {object} params
     * @param {Uint8Array} params.publicKey        — our 33-byte compressed pubkey
     * @param {Uint8Array} [params.secretKey]      — our secret (optional, improves randomness)
     * @param {Uint8Array} [params.sessionId]      — 32 bytes; if omitted, library uses secure random
     * @param {Uint8Array} [params.xOnlyPublicKey] — aggregated x-only pubkey (binds nonce to the key-agg ctx)
     * @param {Uint8Array} [params.msg]            — 32-byte message to be signed
     * @param {Uint8Array} [params.extraInput]     — additional entropy
     * @returns {Uint8Array} 66-byte publicNonce (secretNonce is stashed internally by the library)
     */
    generateNonce(params) {
        if (!params || typeof params !== 'object')
            throw new SDKMuSigError('INVALID_INPUT', 'generateNonce params required');
        requireBytes(params.publicKey, 'publicKey', 33);
        if (params.secretKey !== undefined)      requireBytes(params.secretKey, 'secretKey', 32);
        if (params.sessionId !== undefined)      requireBytes(params.sessionId, 'sessionId', 32);
        if (params.xOnlyPublicKey !== undefined) requireBytes(params.xOnlyPublicKey, 'xOnlyPublicKey', 32);
        if (params.msg !== undefined)            requireBytes(params.msg, 'msg', 32);
        try {
            return _musig.nonceGen(params);
        } catch (e) {
            throw new SDKMuSigError('NONCE_GEN_FAILED', e.message);
        }
    }

    /*
     * Aggregate N 66-byte public nonces into a single 66-byte aggNonce.
     */
    aggregateNonces(publicNonces) {
        if (!Array.isArray(publicNonces) || publicNonces.length < 2)
            throw new SDKMuSigError('INVALID_INPUT',
                'publicNonces must be an array of at least 2 nonces');
        publicNonces.forEach((n, i) => requireBytes(n, 'publicNonces[' + i + ']', 66));
        try {
            return _musig.nonceAgg(publicNonces);
        } catch (e) {
            throw new SDKMuSigError('NONCE_AGG_FAILED', e.message);
        }
    }

    /*
     * Start a MuSig2 signing session. Produces a SessionKey consumed
     * by partialSign / verifyPartial / aggregateSignatures.
     *
     * @param {Uint8Array} aggNonce       — 66-byte aggregated nonce
     * @param {Uint8Array} msg            — 32-byte message
     * @param {(Uint8Array|string)[]} publicKeys
     * @param {Uint8Array[]} [tweaks]
     * @returns {object} SessionKey { publicKey, aggNonce, msg }
     */
    startSession(aggNonce, msg, publicKeys, tweaks) {
        requireBytes(aggNonce, 'aggNonce', 66);
        requireBytes(msg, 'msg', 32);
        let keys = normalizePubkeys(publicKeys);
        try {
            return tweaks && tweaks.length > 0
                ? _musig.startSigningSession(aggNonce, msg, keys, ...tweaks)
                : _musig.startSigningSession(aggNonce, msg, keys);
        } catch (e) {
            throw new SDKMuSigError('SESSION_START_FAILED', e.message);
        }
    }

    /*
     * Produce a 32-byte partial signature using the secret nonce
     * cached from the corresponding generateNonce call.
     *
     * @param {object} params
     * @param {Uint8Array} params.secretKey    — 32 bytes
     * @param {Uint8Array} params.publicNonce  — 66 bytes, must originate from generateNonce on this instance
     * @param {object} params.sessionKey       — from startSession
     * @param {boolean} [params.verify=true]   — self-verify the partial sig
     */
    partialSign(params) {
        if (!params || typeof params !== 'object')
            throw new SDKMuSigError('INVALID_INPUT', 'partialSign params required');
        requireBytes(params.secretKey, 'secretKey', 32);
        requireBytes(params.publicNonce, 'publicNonce', 66);
        if (!params.sessionKey)
            throw new SDKMuSigError('INVALID_INPUT', 'sessionKey required');
        try {
            return _musig.partialSign({
                secretKey:   params.secretKey,
                publicNonce: params.publicNonce,
                sessionKey:  params.sessionKey,
                verify:      params.verify !== false,
            });
        } catch (e) {
            throw new SDKMuSigError('PARTIAL_SIGN_FAILED', e.message);
        }
    }

    /*
     * Verify a partial signature.
     *
     * @returns {boolean}
     */
    verifyPartial(params) {
        if (!params || typeof params !== 'object')
            throw new SDKMuSigError('INVALID_INPUT', 'verifyPartial params required');
        requireBytes(params.sig, 'sig', 32);
        requireBytes(params.publicKey, 'publicKey', 33);
        requireBytes(params.publicNonce, 'publicNonce', 66);
        if (!params.sessionKey)
            throw new SDKMuSigError('INVALID_INPUT', 'sessionKey required');
        try {
            return _musig.partialVerify({
                sig:         params.sig,
                publicKey:   params.publicKey,
                publicNonce: params.publicNonce,
                sessionKey:  params.sessionKey,
            });
        } catch (e) {
            throw new SDKMuSigError('PARTIAL_VERIFY_FAILED', e.message);
        }
    }

    /*
     * Aggregate N 32-byte partial sigs into a single 64-byte Schnorr
     * signature that verifies against the aggregated pubkey.
     */
    aggregateSignatures(sigs, sessionKey) {
        if (!Array.isArray(sigs) || sigs.length < 2)
            throw new SDKMuSigError('INVALID_INPUT',
                'sigs must be an array of at least 2 partial signatures');
        sigs.forEach((s, i) => requireBytes(s, 'sigs[' + i + ']', 32));
        if (!sessionKey)
            throw new SDKMuSigError('INVALID_INPUT', 'sessionKey required');
        try {
            return _musig.signAgg(sigs, sessionKey);
        } catch (e) {
            throw new SDKMuSigError('SIG_AGG_FAILED', e.message);
        }
    }
}


module.exports = MuSig2;
module.exports.MuSig2 = MuSig2;
// Exposed for integration testing against the raw library surface.
module.exports._internal = { ecc, musig: _musig };
