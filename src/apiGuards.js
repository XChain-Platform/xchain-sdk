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
 * XChain Platform SDK - Helper-API request guards
 *
 * The batch fan-out cap and the request-rate limiter used by src/api.js, in
 * their own module because src/api.js starts a live server at require time
 * (dotenv.config() + app.listen) and therefore cannot be require()'d by a unit
 * test. Keeping the guards here gives the shipped middleware ONE implementation
 * that both api.js and the tests load, instead of a copy in each test file that
 * stays green when the real guard regresses.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

/*
 * Maximum JSON-RPC calls in one array (batch) body. Env-tunable because a
 * legitimate integrator may batch more than the default; a non-numeric or
 * non-positive value falls back to the default rather than disabling the cap
 * (a NaN cap used in a > comparison never fires, so the fallback IS the guard).
 *
 * @param {object} [env]
 * @returns {number}
 */
function resolveMaxBatch(env = process.env) {
    const n = parseInt(env.SDK_API_MAX_BATCH, 10);
    return (Number.isFinite(n) && n > 0) ? n : 20;
}

/*
 * Requests per window per credential (per source address when unauthenticated).
 * A junk value falls back to the default; an explicit 0 disables the limiter,
 * which is the only way to turn it off.
 *
 * @param {object} [env]
 * @returns {number}
 */
function resolveRateLimit(env = process.env) {
    const n = parseInt(env.SDK_API_RATE_LIMIT, 10);
    return (Number.isFinite(n) && n >= 0) ? n : 300;
}

/*
 * Length of the fixed rate-limit window in milliseconds.
 *
 * @param {object} [env]
 * @returns {number}
 */
function resolveRateWindowMs(env = process.env) {
    const n = parseInt(env.SDK_API_RATE_WINDOW_MS, 10);
    return (Number.isFinite(n) && n > 0) ? n : 60000;
}

/*
 * Batch fan-out cap. Mount BEFORE the auth gate and the router. A JSON-RPC
 * array body is dispatched element by element and concurrently by
 * express-json-rpc-router, and the body-size limit bounds BYTES, not call
 * count: one ~100KB body holds thousands of {"method":"ping"} calls, so a
 * single request amplifies into thousands of concurrent backend RPCs. Capping
 * ahead of the auth gate bounds the unauthenticated ping path too, and ahead of
 * the router means nothing is dispatched before the count is known good.
 *
 * @param {number} maxBatch
 * @returns {function} express middleware
 */
function batchCapMiddleware(maxBatch) {
    return function batchCap(req, res, next) {
        if (Array.isArray(req.body) && req.body.length > maxBatch)
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: {
                    code: -32600,
                    message: 'Invalid Request: batch of ' + req.body.length +
                             ' calls exceeds the maximum of ' + maxBatch
                }
            });
        next();
    };
}

/*
 * Per-credential (falling back to per-IP) request-rate limit. Mount ahead of
 * the auth gate so an anonymous ping flood is bounded too. The API key stops
 * ANONYMOUS use; it does nothing about sustained traffic from a valid, shared
 * or leaked credential, and the batch cap bounds one request's fan-out rather
 * than the request rate. The two are complementary and neither substitutes for
 * the other.
 *
 * Deliberately dependency-free (a fixed window in a Map) rather than
 * express-rate-limit: this process is a single helper API, adding a runtime
 * dependency to a published SDK for ~20 lines is a poor trade, and a fixed
 * window is the right shape for "stop a runaway client", which is what this
 * surface needs. Keys are HASHED so a long-lived map never holds a raw
 * credential, and expired buckets are pruned so the map cannot grow without
 * bound under rotating keys.
 *
 * The returned middleware exposes its bucket Map as .buckets so a test can
 * assert the hashing and the pruning on the shipped structure itself.
 *
 * @param {{limit: number, windowMs: number}} options
 * @returns {function} express middleware
 */
function rateLimitMiddleware({ limit, windowMs }) {
    const buckets = new Map();
    const rateLimit = function rateLimit(req, res, next) {
        if (limit <= 0) return next();                    // 0 disables
        const header = req.headers['authorization'];
        const token  = (typeof header === 'string' && header.startsWith('Bearer ')) ? header.slice(7) : null;
        const ident  = token ? ('k:' + token) : ('a:' + (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'));
        const key    = crypto.createHash('sha256').update(ident).digest('hex');

        const now = Date.now();
        for (const [k, b] of buckets)
            if (b.resetAt <= now) buckets.delete(k);

        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (bucket.count > limit) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                jsonrpc: '2.0', id: null,
                error: {
                    code: -32005,
                    message: 'Too many requests: limit is ' + limit +
                             ' per ' + windowMs + 'ms. Retry after ' + retryAfter + 's.'
                }
            });
        }
        next();
    };
    rateLimit.buckets = buckets;
    return rateLimit;
}

module.exports = {
    resolveMaxBatch,
    resolveRateLimit,
    resolveRateWindowMs,
    batchCapMiddleware,
    rateLimitMiddleware
};
