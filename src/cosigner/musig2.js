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
 * XChain Platform SDK - MuSig2 Primitives (BIP327)
 *
 * Key aggregation, nonce generation, partial signing, and signature
 * aggregation for MuSig2, used by Taproot-MuSig2 multisig wallets.
 *
 * MuSig2-aggregated signatures are indistinguishable from single-sig
 * Schnorr signatures on chain: the VM / decoder / indexer / explorer
 * see a single Schnorr sig under a P2TR output.
 *
 * Wraps @brandonblack/musig (BitGo's production dependency via
 * @bitgo/secp256k1) with a Crypto adapter built from @noble/curves +
 * @noble/hashes + @brandonblack/musig/base_crypto.
 *
 * IMPORTANT: the two-round flow (generateNonce + partialSign) must
 * happen on the same module instance. The underlying library uses an
 * internal nonce cache keyed by publicNonce; a publicNonce generated on
 * one process cannot be partially-signed on another without also
 * transferring the secret nonce, which intentionally is not exposed by
 * this module. Cross-process signing (e.g. a remote co-signer) uses
 * deterministicSign() instead: it derives the secret nonce
 * deterministically and returns the public nonce + partial signature in
 * one stateless call, so nothing has to persist between rounds.
 *
 ********************************************************************/

const { SDKMuSigError } = require('../utils/errors.js');
const { ecc, _musig, requireBytes, normalizePubkeys, concat } = require('./musig2/curve_adapter.js');


// SessionIds this process has already generated a nonce under, keyed publicKey|sessionId.
const _nonceSessions = new Set();

// Refuses EVERY repeat of a (publicKey, sessionId) pair: a sessionId is single-use.
// BIP327 derives the SECRET nonce from it, so a second generateNonce hands back a second
// live handle on the SAME secret nonce (the library caches it in a WeakMap keyed by the
// returned array's identity, and partialSign drops only the handle it consumed), and two
// partial signatures under one secret nonce solve for the private key. Byte-identical
// arguments are not evidence the repeat is safe: msg is optional and the aggregate nonce
// is unknowable at round 1, so the two nonces can still be spent under different
// challenges. Stateless retry is deterministicSign, never a replayed sessionId. Calls
// that omit sessionId are untracked (the library uses secure random, nothing to reuse).
function guardSessionIdReuse(params) {
    if (params.sessionId === undefined) return;
    const part = (v) => (v === undefined || v === null ? '' : Buffer.from(v).toString('hex'));
    const key = part(params.publicKey) + '|' + part(params.sessionId);
    if (_nonceSessions.has(key))
        throw new SDKMuSigError('SESSION_ID_REUSED',
            'this sessionId was already used to generate a nonce for this key; a MuSig2 sessionId is '
            + 'single-use, and regenerating its nonce lets one secret nonce be spent in two signing '
            + 'sessions, which discloses the private key. Pass a fresh 32-byte sessionId, omit it, or '
            + 'use deterministicSign for stateless retry');
    _nonceSessions.add(key);
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
     * @param {(Uint8Array|string)[]} publicKeys  33-byte compressed pubkeys
     * @param {Uint8Array[]} [tweaks]             optional post-aggregation tweaks
     * @returns {object} KeyGenContext:
     *   {
     *     aggPublicKey: Uint8Array(33),  compressed aggregated pubkey
     *     xOnlyPubkey:  Uint8Array(32),  x-only form for Taproot
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
     * @param {Uint8Array} params.publicKey        our 33-byte compressed pubkey
     * @param {Uint8Array} [params.secretKey]      our secret (optional, improves randomness)
     * @param {Uint8Array} [params.sessionId]      32 bytes, SINGLE-USE per publicKey (a repeat
     *        throws SESSION_ID_REUSED); if omitted, library uses secure random
     * @param {Uint8Array} [params.xOnlyPublicKey] aggregated x-only pubkey (binds nonce to the key-agg ctx)
     * @param {Uint8Array} [params.msg]            32-byte message to be signed
     * @param {Uint8Array} [params.extraInput]     additional entropy
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
        guardSessionIdReuse(params);
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
     * @param {Uint8Array} aggNonce       66-byte aggregated nonce
     * @param {Uint8Array} msg            32-byte message
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
     * @param {Uint8Array} params.secretKey    32 bytes
     * @param {Uint8Array} params.publicNonce  66 bytes, must originate from generateNonce on this instance
     * @param {object} params.sessionKey       from startSession
     * @param {boolean} [params.verify=true]   self-verify the partial sig
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

    /*
     * Stateless single-call partial signing (BIP327 deterministicSign).
     *
     * Unlike generateNonce + partialSign (two rounds that MUST share one live
     * module instance, because the secret nonce is cached in-process), this
     * derives the secret nonce deterministically from (secretKey, aggOtherNonce,
     * publicKeys, msg) and returns the public nonce AND partial signature in one
     * call. That is what lets a remote/stateless co-signer participate: it never
     * has to persist a secret nonce between two requests. The deterministic
     * signer must be the LAST signer (it needs every other signer's nonce first).
     *
     * @param {object} params
     * @param {Uint8Array} params.secretKey            our 32-byte secret key
     * @param {(Uint8Array|string)[]} params.publicKeys  full signer set, in the
     *        same order + tweaks the other signers used (keyAgg runs internally)
     * @param {Uint8Array} params.msg                  32-byte message (sighash)
     * @param {Uint8Array} [params.aggOtherNonce]      66-byte aggregate of every
     *        OTHER signer's public nonce, OR pass otherPublicNonces instead
     * @param {Uint8Array[]} [params.otherPublicNonces] the other signers' 66-byte
     *        public nonces; aggregated here (use this for the common 2-of-2 case,
     *        where it is just the single counterparty nonce)
     * @param {Uint8Array} [params.rand]               optional 32-byte aux entropy;
     *        OMIT for a fully deterministic nonce (the whole point here)
     * @param {boolean} [params.verify=true]           self-verify the partial sig
     * @param {boolean} [params.nonceOnly=false]       return only { publicNonce }
     * @returns {object} { sig:Uint8Array(32), sessionKey, publicNonce:Uint8Array(66) }
     *          (or { publicNonce } when nonceOnly)
     */
    deterministicSign(params) {
        if (!params || typeof params !== 'object')
            throw new SDKMuSigError('INVALID_INPUT', 'deterministicSign params required');
        requireBytes(params.secretKey, 'secretKey', 32);
        requireBytes(params.msg, 'msg', 32);
        if (params.rand !== undefined) requireBytes(params.rand, 'rand', 32);
        let keys = normalizePubkeys(params.publicKeys);

        // aggOtherNonce is the aggregation of every OTHER signer's public nonce.
        // Accept it pre-aggregated (66 bytes), or aggregate an array here. For a
        // single counterparty (2-of-2) nonceAgg of one element is that nonce itself.
        let aggOtherNonce;
        if (params.aggOtherNonce !== undefined) {
            requireBytes(params.aggOtherNonce, 'aggOtherNonce', 66);
            aggOtherNonce = params.aggOtherNonce;
        } else if (Array.isArray(params.otherPublicNonces) && params.otherPublicNonces.length >= 1) {
            params.otherPublicNonces.forEach((n, i) =>
                requireBytes(n, 'otherPublicNonces[' + i + ']', 66));
            try {
                aggOtherNonce = _musig.nonceAgg(params.otherPublicNonces);
            } catch (e) {
                throw new SDKMuSigError('NONCE_AGG_FAILED', e.message);
            }
        } else {
            throw new SDKMuSigError('INVALID_INPUT',
                'deterministicSign requires aggOtherNonce (66 bytes) or a non-empty otherPublicNonces array');
        }

        try {
            return _musig.deterministicSign({
                secretKey:     params.secretKey,
                aggOtherNonce: aggOtherNonce,
                publicKeys:    keys,
                tweaks:        params.tweaks || [],
                msg:           params.msg,
                rand:          params.rand,
                verify:        params.verify !== false,
                nonceOnly:     params.nonceOnly === true,
            });
        } catch (e) {
            throw new SDKMuSigError('DETERMINISTIC_SIGN_FAILED', e.message);
        }
    }
}


module.exports = Object.assign(MuSig2, {
    MuSig2,
    // Exposed for integration testing against the raw library surface.
    _internal: { ecc, musig: _musig },
});
