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
function assertMsgMatchesPsbt(psbtHex, inputIndex, msg) {
    let expected;
    try {
        const psbt = bitcoin.Psbt.fromHex(psbtHex);
        expected = taprootKeyPathSighash(psbt, inputIndex, undefined);
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
        // A reverse proxy in front of the sidecar can answer 502/504 with an HTML
        // error page; without this guard res.json() throws an opaque SyntaxError
        // and a non-2xx JSON body would be mistaken for a normal result. Surface
        // the transport fault distinctly from a policy denial, tagged with the
        // endpoint + status so operators can tell them apart.
        if (!res.ok)
            throw new SDKPolicyError('COSIGNER_TRANSPORT_ERROR',
                'co-signer sidecar ' + endpoint + ' returned HTTP ' + res.status);
        try {
            return await res.json();
        } catch (e) {
            throw new SDKPolicyError('COSIGNER_TRANSPORT_ERROR',
                'co-signer sidecar ' + endpoint + ' returned an unparseable (non-JSON) response: ' + e.message);
        }
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

        // Round 1: agent nonce (secret nonce stays in this.musig).
        const agentNonce = this.musig.generateNonce({ publicKey: agentPub, secretKey });

        // Ask the co-signer to authorize + partial-sign.
        const res = await this.transport({
            psbt:             req.psbt,
            agentPublicNonce: Buffer.from(agentNonce).toString('hex'),
            inputIndex:       Number.isInteger(req.inputIndex) ? req.inputIndex : 0,
        });

        if (!res || res.approved !== true)
            throw new SDKPolicyError(res && res.reason ? res.reason : 'COSIGNER_DENIED',
                'co-signer refused to sign: ' + (res && res.reason ? res.reason : 'unknown'),
                res && res.detail ? { detail: res.detail } : {});

        // Combine: the co-signer derived the message from the PSBT and returned it;
        // we re-aggregate the nonces, build the same session, and add our partial.
        const msg = toBytes(res.msg, 'msg');
        const idx = Number.isInteger(req.inputIndex) ? req.inputIndex : 0;
        assertMsgMatchesPsbt(req.psbt, idx, msg);
        const coNonce = toBytes(res.publicNonce, 'publicNonce');
        const aggNonce = this.musig.aggregateNonces([agentNonce, coNonce]);
        const session  = this.musig.startSession(aggNonce, msg, this.publicKeys, this.tweaks);
        const agentSig = this.musig.partialSign({ secretKey, publicNonce: agentNonce, sessionKey: session });
        const signature = this.musig.aggregateSignatures([agentSig, toBytes(res.sig, 'sig')], session);

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
        const indexes = (Array.isArray(req.inputIndexes) && req.inputIndexes.length) ? req.inputIndexes : [0];

        // Round 1: a unique agent nonce per input (secret nonces stay in this.musig).
        const nonceByIndex = {};
        const inputs = indexes.map((i) => {
            const n = this.musig.generateNonce({ publicKey: agentPub, secretKey });
            nonceByIndex[i] = n;
            return { index: i, agentPublicNonce: Buffer.from(n).toString('hex') };
        });

        const res = await this.transport({ psbt: req.psbt, inputs });
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
            assertMsgMatchesPsbt(req.psbt, s.index, msg);
            const coNonce = toBytes(s.publicNonce, 'publicNonce');
            const aggNonce = this.musig.aggregateNonces([agentNonce, coNonce]);
            const session  = this.musig.startSession(aggNonce, msg, this.publicKeys, this.tweaks);
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
