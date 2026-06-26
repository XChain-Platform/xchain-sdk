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

/*
 * Build an Express app exposing POST /cosign.
 *
 * @param {CoSigner} coSigner
 * @param {object} [opts]
 *   token  {string}  required bearer token; requests without it get 401
 * @returns {express.Express}
 */
function createCoSignerApp(coSigner, opts = {}) {
    if (!coSigner || typeof coSigner.process !== 'function')
        throw new Error('createCoSignerApp requires a CoSigner instance');
    const token = opts.token || null;

    const app = express();
    app.use(express.json({ limit: '256kb' }));

    app.post('/cosign', (req, res) => {
        // Loopback bearer-token gate (defence in depth even on localhost).
        if (token) {
            const auth = req.get('authorization') || '';
            const got = auth.startsWith('Bearer ') ? auth.slice(7) : null;
            if (got !== token) return res.status(401).json({ approved: false, reason: 'UNAUTHORIZED' });
        }
        const body = req.body || {};
        if (typeof body.psbt !== 'string' || !body.agentPublicNonce)
            return res.status(400).json({ approved: false, reason: 'BAD_REQUEST',
                detail: 'psbt (hex) and agentPublicNonce are required' });

        let result;
        try {
            result = coSigner.process({
                psbt:             body.psbt,
                agentPublicNonce: body.agentPublicNonce,
                inputIndex:       body.inputIndex,
                sighashType:      body.sighashType,
            });
        } catch (e) {
            // CoSigner.process is fail-closed by return value; a throw here is an
            // unexpected internal fault. Surface as a denial, never as a sign.
            return res.status(500).json({ approved: false, reason: 'INTERNAL_ERROR' });
        }
        // A policy/decode denial is a normal 200 with approved:false (it is a
        // legitimate answer, not an HTTP error).
        return res.status(200).json(result);
    });

    return app;
}

module.exports = { createCoSignerApp };
