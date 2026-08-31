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
 * XChain Platform SDK - Co-Signer HTTP Sidecar
 *
 * A thin Express wrapper around the transport-agnostic CoSigner. Per the
 * locked deployment decision this is the LOCAL SIDECAR: bind to loopback
 * and gate with a shared bearer token. (A hosted multi-tenant variant is a
 * later, additive offering.) All policy/sign logic lives in CoSigner; this
 * file only does transport + auth + shape-checking.
 *
 *   const app = createCoSignerApp(coSigner, { token: process.env.COSIGNER_TOKEN });
 *   app.listen(8787, '127.0.0.1');
 *
 ********************************************************************/

'use strict';

const express = require('express');
const { safeTokenEqual } = require('../utils/safeCompare.js');
// One body ceiling for BOTH co-signer transports, derived from the protocol's
// envelope payload maximum rather than hardcoded here (httpBodyLimit.js).
const { resolveMaxBodyBytes, tooLargeHandler } = require('./httpBodyLimit.js');

/*
 * Build an Express app exposing POST /cosign.
 *
 * @param {CoSigner} coSigner
 * @param {object} [opts]
 *   token  {string}  required bearer token; requests without it get 401.
 *                    Construction THROWS when it is absent/empty unless
 *                    allowUnauthenticated:true is passed (see below).
 *   allowUnauthenticated {boolean}  test/dev-only escape hatch: run /cosign
 *                    with no bearer gate. Emits a loud boot warning. Never set
 *                    in production; the sidecar signs spending authority.
 *   logger {function}  optional (level, message, context) sink for internal
 *                    faults and denial reasons (G17). Defaults to the console,
 *                    which a process manager already captures durably.
 *   maxBodyBytes {number}  request-body ceiling; defaults to the derived
 *                    envelope-round maximum (httpBodyLimit.js). Anything past
 *                    it answers 413 REQUEST_TOO_LARGE, at whatever value is set.
 * @returns {express.Express}
 */
function createCoSignerApp(coSigner, opts = {}) {
    if (!coSigner || typeof coSigner.process !== 'function')
        throw new Error('createCoSignerApp requires a CoSigner instance');
    const token = opts.token || null;
    // Fail CLOSED on a missing token: a misconfigured sidecar (unset
    // COSIGNER_TOKEN) must not silently serve unauthenticated MuSig2 signatures.
    // Mirrors the fail-closed auth gate in src/api.js. The gate is skippable
    // only by a deliberate allowUnauthenticated:true (tests/regtest).
    if (!token) {
        if (opts.allowUnauthenticated !== true)
            throw new Error('createCoSignerApp requires a non-empty opts.token (set COSIGNER_TOKEN), or pass { allowUnauthenticated: true } to run the endpoint deliberately unauthenticated');
        console.warn('[cosigner] WARNING: /cosign is running UNAUTHENTICATED (allowUnauthenticated=true). Never do this in production; the sidecar signs spending authority.');
    }

    // Operator-visible log sink (G17). Defaults to the console, which under a
    // process manager (pm2/systemd) is already a durable operator log. Injectable
    // so a deployment can route it somewhere with retention, and so tests can
    // assert that faults and denials are actually reported.
    const sink = typeof opts.logger === 'function' ? opts.logger : null;
    const log = (level, message, context) => {
        if (sink) {
            try { sink(level, message, context); return; } catch (e) { /* a log sink must never break enforcement */ }
        }
        const line = `[cosigner] ${message}` + (context ? ' ' + JSON.stringify(context) : '');
        if (level === 'error') console.error(line); else console.warn(line);
    };

    const maxBodyBytes = resolveMaxBodyBytes(opts.maxBodyBytes);

    const app = express();
    app.use(express.json({ limit: maxBodyBytes }));

    app.post('/cosign', (req, res) => {
        // Loopback bearer-token gate (defence in depth even on localhost).
        if (token) {
            const auth = req.get('authorization') || '';
            const got = auth.startsWith('Bearer ') ? auth.slice(7) : null;
            if (!safeTokenEqual(got, token)) {
                // G17: a bad bearer token is a denial too, and the one an operator
                // most needs a trail of (a rotated token, or a probe).
                log('warn', 'co-sign request rejected: bad bearer token', { present: got !== null });
                return res.status(401).json({ approved: false, reason: 'UNAUTHORIZED' });
            }
        }
        const body = req.body || {};
        // ONE request shape (wire collapse, 2026-07-27): { psbt, inputs[], sighashType? }.
        // The legacy single-input body ({ agentPublicNonce, inputIndex }) is gone -
        // a one-element inputs array says the same thing, and two shapes meant two
        // validation paths for every fix applied here. CoSignerClient.sign() does
        // the wrapping, so single-input callers are unaffected.
        if (typeof body.psbt !== 'string' || !Array.isArray(body.inputs) || body.inputs.length === 0) {
            log('warn', 'co-sign request rejected: malformed body', {
                hasPsbt: typeof body.psbt === 'string', inputs: Array.isArray(body.inputs) ? body.inputs.length : null,
            });
            return res.status(400).json({ approved: false, reason: 'BAD_REQUEST',
                detail: 'psbt (hex) and a non-empty inputs[] of { index, agentPublicNonce } are required' });
        }

        let result;
        try {
            // `envelope` (§3.9) is forwarded verbatim when present: the
            // daemon validates it (grammar, own-key commitment, and whether the
            // PSBT actually funds or spends it), so nothing here needs to judge
            // it, and forwarding an absent field must stay a no-op for every
            // ordinary request.
            result = coSigner.process({
                psbt: body.psbt, inputs: body.inputs, sighashType: body.sighashType,
                envelope: body.envelope,
            });
        } catch (e) {
            // CoSigner.process is fail-closed by return value; a throw here is an
            // unexpected internal fault. Surface as a denial, never as a sign.
            //
            // G17: LOG it, with the stack, before answering. The wire response stays
            // deliberately detail-free (it goes to the agent), but discarding the
            // error entirely meant a poisoned-tick freeze and a corrupt window store
            // both presented to the operator as an unexplained 500 with no way to
            // tell them apart. The diagnosis belongs in the log, not on the wire.
            log('error', 'internal fault while processing a co-sign request', {
                message: e && e.message, code: e && e.code, stack: e && e.stack,
            });
            return res.status(500).json({ approved: false, reason: 'INTERNAL_ERROR' });
        }
        // G17: denials are not persisted anywhere (the window store records only
        // APPROVALS), so without this there is no refusal trail at all - an operator
        // debugging "the agent cannot spend" had nothing to read.
        if (result && result.approved !== true)
            log('warn', 'co-sign request denied', { reason: result.reason, detail: result.detail });
        // A policy/decode denial is a normal 200 with approved:false (it is a
        // legitimate answer, not an HTTP error).
        return res.status(200).json(result);
    });

    // After the route: an oversize body is a stated capability limit, not a
    // network fault (httpBodyLimit.js). Everything else falls through.
    app.use(tooLargeHandler(maxBodyBytes, log));

    return app;
}

module.exports = { createCoSignerApp };
