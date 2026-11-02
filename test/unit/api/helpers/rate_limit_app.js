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
 * XChain Platform SDK - shared app and server helpers for the API request-rate limit tests
 *
 ********************************************************************/

'use strict';

const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { rateLimitMiddleware } = require('../../../../src/utils/api_guards.js');

// Tests that exercise per-credential bucketing pass the credentials the app
// would accept (src/api/index.js passes a safeTokenEqual-against-SDK_API_KEY
// predicate); with no predicate every caller is bucketed by source address.
const KNOWN_KEYS = (token) => token === 'key-a' || token === 'key-b' ||
                              token === 'k1' || token === 'k2' || token === 'super-secret-token';

function buildApp(limit, windowMs, isCredential = KNOWN_KEYS) {
    const app = express();
    app.use(bodyParser.json());
    // The shipped limiter itself, not a reconstruction of it.
    const limiter = rateLimitMiddleware({ limit, windowMs, isCredential });
    app.use(limiter);
    app.use((req, res) => res.status(200).json({ jsonrpc: '2.0', id: null, result: 'ok' }));
    app._rateBuckets = limiter.buckets;                   // the limiter's own map
    return app;
}

// One server per describe block so repeated requests share the limiter state.
async function withServer(app, fn) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const send = async (headers = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        });
        return { status: res.status, retryAfter: res.headers.get('retry-after'), json: await res.json() };
    };
    try { return await fn(send); }
    finally { await new Promise((resolve) => server.close(resolve)); }
}

module.exports = { KNOWN_KEYS, buildApp, withServer };
