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
 * XChain Platform SDK - Co-Signer Client (agent side)
 *
 * The live signer half of the 2-of-2 MuSig2 spend. Given a PSBT and the
 * agent's secret key, it: generates the agent's nonce, asks the co-signer
 * to authorize-and-partial-sign (transport-agnostic), and if approved
 * combines the two partials into the final 64-byte Schnorr signature that
 * is the Taproot key-path witness.
 *
 * Transport-agnostic: pass any `transport(body) -> Promise<result>`. Use
 * httpTransport() for the loopback sidecar, or inProcessTransport(coSigner)
 * to drive a CoSigner directly (tests, single-process deployments).
 *
 * The co-signer is the policy authority; if it denies, this throws a
 * SDKPolicyError carrying the reason - the spend cannot complete.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1 } = require('@noble/curves/secp256k1');
const MuSig2 = require('../musig2.js');
const { deriveEnvelopeCommit, classifyEnvelopeRole, envelopeScriptPathSighash } = require('./envelope.js');
const { SDKPolicyError } = require('../errors.js');
const { taprootKeyPathSighash } = require('./coSigner.js');

function toBytes(v, label) {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return Buffer.from(v, 'hex');
    throw new Error(label + ' must be a hex string or Uint8Array');
}

/*
 * Bind the co-signer's returned msg to the PSBT the agent actually submitted:
 * recompute the BIP341 key-path sighash locally and refuse to sign anything
 * else. A buggy/misconfigured co-signer then fails loudly HERE instead of the
 * agent emitting a signature over the wrong message that later dies as an
 * opaque network rejection. Throws SDKPolicyError on mismatch.
 */
// `envelope` is the envelope context this round is signing under, when there is
// one ( §3.9): a REVEAL's message is the BIP342 tapleaf sighash, not the
// key-path one, so re-deriving it the old way would report every honest reveal
// as a COSIGNER_MSG_MISMATCH. The leaf hash is computed HERE from the agent's
// own copy of the envelope script, so this stays an independent check of the
// daemon's message rather than a rubber stamp on whatever it returned.
function assertMsgMatchesPsbt(psbtHex, inputIndex, msg, envelope) {
    let expected;
    try {
        const psbt = bitcoin.Psbt.fromHex(psbtHex);
        expected = (envelope && envelope.role === 'reveal')
            ? envelopeScriptPathSighash(psbt, inputIndex, undefined, envelope.commit.leafHash)
            : taprootKeyPathSighash(psbt, inputIndex, undefined);
    } catch (e) {
        throw new SDKPolicyError('COSIGNER_MSG_UNVERIFIABLE',
            'cannot recompute the sighash for input ' + inputIndex + ' to verify the co-signer msg: ' + e.message);
    }
    const got = Buffer.from(msg);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got))
        throw new SDKPolicyError('COSIGNER_MSG_MISMATCH',
            'co-signer msg is not the sighash of the submitted PSBT (input ' + inputIndex +
            ': expected ' + expected.toString('hex') + ', got ' + got.toString('hex') + ')');
}

// Drive a CoSigner instance directly (no network). Useful for tests and
// single-process setups.
function inProcessTransport(coSigner) {
    if (!coSigner || typeof coSigner.process !== 'function')
        throw new Error('inProcessTransport requires a CoSigner instance');
    return async (body) => coSigner.process(body);
}

// POST the request to a loopback sidecar (createCoSignerApp). Requires a fetch
// implementation (global fetch on Node 18+, or pass one in).
function httpTransport(endpoint, opts = {}) {
    const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('httpTransport needs a fetch implementation');
    const headers = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    return async (body) => {
        const res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });

        // G13: read the BODY on a non-2xx before deciding what went wrong. The
        // sidecar answers 401 UNAUTHORIZED, 400 BAD_REQUEST and 500 INTERNAL_ERROR
        // with a documented `reason`, and throwing COSIGNER_TRANSPORT_ERROR without
        // looking made all three indistinguishable from a dead sidecar - which is
        // exactly the distinction an operator needs mid-incident (a rotated or
        // mistyped token looked identical to a crashed daemon). Only a genuine
        // network fault or a non-JSON body may collapse to the transport error; a
        // reverse proxy answering 502 with an HTML page still lands there.
        let parsed = null;
        try { parsed = await res.json(); } catch (e) { parsed = null; }

        if (!res.ok) {
            if (parsed && typeof parsed.reason === 'string')
                throw new SDKPolicyError(parsed.reason,
                    'co-signer sidecar ' + endpoint + ' returned HTTP ' + res.status + ': ' + parsed.reason,
                    parsed.detail ? { detail: parsed.detail } : {});
            throw new SDKPolicyError('COSIGNER_TRANSPORT_ERROR',
                'co-signer sidecar ' + endpoint + ' returned HTTP ' + res.status +
                ' with no usable body (dead sidecar, or a proxy error page)');
        }
        if (parsed === null)
            throw new SDKPolicyError('COSIGNER_TRANSPORT_ERROR',
                'co-signer sidecar ' + endpoint + ' returned an unparseable (non-JSON) response');
        return parsed;
    };
}

class CoSignerClient {

    /*
     * @param {object} config
     *   transport   {function}  body -> Promise<result> (see inProcessTransport/httpTransport)
     *   publicKeys  {(Uint8Array|hex)[]}  full signer set, agreed order (must match the co-signer)
     *   tweaks      {Array}  optional; must match the co-signer (deriveMuSig2P2TR -> []).
     */
    constructor(config = {}) {
        if (typeof config.transport !== 'function')
            throw new Error('CoSignerClient requires a transport function');
        if (!Array.isArray(config.publicKeys) || config.publicKeys.length < 2)
            throw new Error('CoSignerClient requires the full publicKeys set');
        this.transport = config.transport;
        this.publicKeys = config.publicKeys;
        this.tweaks = config.tweaks || [];
        this.musig = new MuSig2();
        // The account's aggregate x-only key: the envelope commit output's
        // internal key. Derived here so the agent computes the leaf hash and
        // the cancel tweak itself and never adopts the daemon's word for either.
        this.aggregateXOnly = Buffer.from(this.musig.aggregateKeys(this.publicKeys, this.tweaks).xOnlyPubkey);
    }

    // Build this round's envelope context from the agent's OWN copy of the
    // script, mirroring the daemon's derivation exactly (both call the same
    // module). Returns null when the round is not an envelope round.
    _envelopeContext(psbtHex, envelopeScript, network) {
        if (!envelopeScript) return null;
        const script = Buffer.isBuffer(envelopeScript) ? envelopeScript : Buffer.from(String(envelopeScript), 'hex');
        const commit = deriveEnvelopeCommit({
            internalXOnly: this.aggregateXOnly, envelopeScript: script, network: network || undefined,
        });
        const psbt = bitcoin.Psbt.fromHex(psbtHex, network ? { network } : undefined);
        const role = classifyEnvelopeRole(psbt, commit);
        if (!role) throw new SDKPolicyError('COSIGNER_CONFIG',
            'the supplied envelope script neither funds nor spends this PSBT');
        return { commit, role, script };
    }

    /*
     * Produce the final Taproot key-path signature for one input, gated by the
     * co-signer's policy.
     *
     * @param {object} req
     *   psbt       {string} PSBT hex
     *   secretKey  {Uint8Array|hex}  the agent's key
     *   inputIndex {number} default 0
     * @returns {Promise<object>}
     *   { signature:Buffer(64), msg:Buffer(32), action }     on approval
     * @throws {SDKPolicyError}  when the co-signer denies (reason in .code)
     */
    async sign(req = {}) {
        const secretKey = toBytes(req.secretKey, 'secretKey');
        const agentPub  = secp256k1.getPublicKey(secretKey, true);
        const env = this._envelopeContext(req.psbt, req.envelopeScript, req.network);

        // Round 1: agent nonce (secret nonce stays in this.musig).
        const agentNonce = this.musig.generateNonce({ publicKey: agentPub, secretKey });

        // Ask the co-signer to authorize + partial-sign. The wire carries exactly
        // ONE request shape (the inputs array); the single-input convenience is
        // this method's job, so the daemon keeps a single validation path.
        const idx = Number.isInteger(req.inputIndex) ? req.inputIndex : 0;
        const res = await this.transport(Object.assign({
            psbt:   req.psbt,
            inputs: [{ index: idx, agentPublicNonce: Buffer.from(agentNonce).toString('hex') }],
        }, env ? { envelope: { script: env.script.toString('hex') } } : {}));

        if (!res || res.approved !== true)
            throw new SDKPolicyError(res && res.reason ? res.reason : 'COSIGNER_DENIED',
                'co-signer refused to sign: ' + (res && res.reason ? res.reason : 'unknown'),
                res && res.detail ? { detail: res.detail } : {});

        // Unwrap the one-element signatures array back into the single-input
        // result this method has always returned.
        if (!Array.isArray(res.signatures) || res.signatures.length !== 1)
            throw new SDKPolicyError('COSIGNER_BAD_RESPONSE',
                'co-signer approved but did not return exactly one signature for a single-input request');
        const sig0 = res.signatures[0];
        if (sig0.index !== idx)
            throw new SDKPolicyError('COSIGNER_BAD_RESPONSE',
                'co-signer returned a signature for input ' + sig0.index + ', not the requested ' + idx);

        // Combine: the co-signer derived the message from the PSBT and returned it;
        // we re-aggregate the nonces, build the same session, and add our partial.
        const msg = toBytes(sig0.msg, 'msg');
        assertMsgMatchesPsbt(req.psbt, idx, msg, env);
        const coNonce = toBytes(sig0.publicNonce, 'publicNonce');
        const aggNonce = this.musig.aggregateNonces([agentNonce, coNonce]);
        // A cancel spends the commit output's KEY path, whose output key commits
        // to the envelope leaf, so the session carries the derived tap tweak.
        // Every other round (including a reveal, which signs the leaf's bare
        // aggregate key) keeps this account's own tweaks.
        const roundTweaks = (env && env.role === 'cancel')
            ? [{ tweak: env.commit.tweak, xOnly: true }] : this.tweaks;
        const session  = this.musig.startSession(aggNonce, msg, this.publicKeys, roundTweaks);
        const agentSig = this.musig.partialSign({ secretKey, publicNonce: agentNonce, sessionKey: session });
        const signature = this.musig.aggregateSignatures([agentSig, toBytes(sig0.sig, 'sig')], session);

        return { signature: Buffer.from(signature), msg: Buffer.from(msg), action: res.action };
    }

    /*
     * Multi-input variant: co-sign a tx that spends several UTXOs of the aggregate
     * account in ONE round (one authorization on the co-signer side). Generates a
     * distinct nonce per input (never reused), sends them together, and aggregates
     * each input's partials into its final key-path signature.
     *
     * @param {object} req
     *   psbt          {string} PSBT hex
     *   secretKey     {Uint8Array|hex}  the agent's key
     *   inputIndexes  {number[]}  inputs to co-sign (default [0])
     * @returns {Promise<object>}
     *   { signatures:[{ index, signature:Buffer(64), msg:Buffer(32) }], action }
     * @throws {SDKPolicyError}  when the co-signer denies
     */
    async signAll(req = {}) {
        const secretKey = toBytes(req.secretKey, 'secretKey');
        const agentPub  = secp256k1.getPublicKey(secretKey, true);
        const env = this._envelopeContext(req.psbt, req.envelopeScript, req.network);
        const indexes = (Array.isArray(req.inputIndexes) && req.inputIndexes.length) ? req.inputIndexes : [0];

        // Round 1: a unique agent nonce per input (secret nonces stay in this.musig).
        const nonceByIndex = {};
        const inputs = indexes.map((i) => {
            const n = this.musig.generateNonce({ publicKey: agentPub, secretKey });
            nonceByIndex[i] = n;
            return { index: i, agentPublicNonce: Buffer.from(n).toString('hex') };
        });

        const res = await this.transport(Object.assign({ psbt: req.psbt, inputs },
            env ? { envelope: { script: env.script.toString('hex') } } : {}));
        if (!res || res.approved !== true)
            throw new SDKPolicyError(res && res.reason ? res.reason : 'COSIGNER_DENIED',
                'co-signer refused to sign: ' + (res && res.reason ? res.reason : 'unknown'),
                res && res.detail ? { detail: res.detail } : {});
        if (!Array.isArray(res.signatures)) throw new SDKPolicyError('COSIGNER_BAD_RESPONSE',
            'co-signer approved but returned no signatures array');

        const signatures = res.signatures.map((s) => {
            const agentNonce = nonceByIndex[s.index];
            if (!agentNonce) throw new SDKPolicyError('COSIGNER_BAD_RESPONSE',
                'co-signer returned a signature for an unrequested input ' + s.index);
            const msg     = toBytes(s.msg, 'msg');
            assertMsgMatchesPsbt(req.psbt, s.index, msg, env);
            const coNonce = toBytes(s.publicNonce, 'publicNonce');
            const aggNonce = this.musig.aggregateNonces([agentNonce, coNonce]);
            const roundTweaks = (env && env.role === 'cancel')
                ? [{ tweak: env.commit.tweak, xOnly: true }] : this.tweaks;
            const session  = this.musig.startSession(aggNonce, msg, this.publicKeys, roundTweaks);
            const agentSig = this.musig.partialSign({ secretKey, publicNonce: agentNonce, sessionKey: session });
            const signature = this.musig.aggregateSignatures([agentSig, toBytes(s.sig, 'sig')], session);
            return { index: s.index, signature: Buffer.from(signature), msg: Buffer.from(msg) };
        });

        return { signatures, action: res.action };
    }
}

module.exports = CoSignerClient;
module.exports.inProcessTransport = inProcessTransport;
module.exports.httpTransport = httpTransport;
