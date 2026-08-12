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
 * XChain Platform SDK - API request-rate limit tests
 *
 * The API key stops ANONYMOUS use; it does nothing about sustained traffic from
 * a valid, shared or leaked credential, and the batch cap bounds one request's
 * fan-out rather than the request rate.
 *
 * src/api.js starts a live server at require time, so these tests mount the
 * SHIPPED limiter from src/apiGuards.js (the same function src/api.js mounts)
 * rather than a copy of it, and a source check pins that api.js still mounts it
 * ahead of the auth gate and the router.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const {
    rateLimitMiddleware,
    resolveRateLimit,
    resolveRateWindowMs
} = require('../../src/apiGuards.js');
const { waitFor } = require('../helpers/wait.js');

function buildApp(limit, windowMs) {
    const app = express();
    app.use(bodyParser.json());
    // The shipped limiter itself, not a reconstruction of it.
    const limiter = rateLimitMiddleware({ limit, windowMs });
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

describe('API request-rate limit', function () {
    this.timeout(10000);

    it('allows requests up to the limit and rejects the next one with 429', async () => {
        const app = buildApp(3, 60000);
        await withServer(app, async (send) => {
            for (let i = 0; i < 3; i++)
                assert.strictEqual((await send()).status, 200, 'request ' + i + ' must be allowed');
            const over = await send();
            assert.strictEqual(over.status, 429);
            assert.strictEqual(over.json.error.code, -32005);
            assert.ok(Number(over.retryAfter) > 0, 'a 429 must tell the caller when to come back');
        });
    });

    it('counts per credential, so one hot key cannot starve another', async () => {
        const app = buildApp(2, 60000);
        await withServer(app, async (send) => {
            await send({ authorization: 'Bearer key-a' });
            await send({ authorization: 'Bearer key-a' });
            assert.strictEqual((await send({ authorization: 'Bearer key-a' })).status, 429);
            // A different credential from the same address still has its budget.
            assert.strictEqual((await send({ authorization: 'Bearer key-b' })).status, 200);
        });
    });

    it('bounds the unauthenticated path too (keyed on the source address)', async () => {
        const app = buildApp(1, 60000);
        await withServer(app, async (send) => {
            assert.strictEqual((await send()).status, 200);
            assert.strictEqual((await send()).status, 429);
        });
    });

    it('the window rolls over and the caller is allowed again', async () => {
        const app = buildApp(1, 40);
        await withServer(app, async (send) => {
            assert.strictEqual((await send()).status, 200);
            assert.strictEqual((await send()).status, 429);
            // Poll the real signal - the window rolling over - instead of sleeping
            // a fixed span past it: keep requesting until the caller is let through.
            await waitFor(async () => (await send()).status === 200,
                { message: 'the rate-limit window should roll over and allow the caller again' });
        });
    });

    it('never holds a raw credential as a map key', async () => {
        const app = buildApp(5, 60000);
        await withServer(app, async (send) => {
            await send({ authorization: 'Bearer super-secret-token' });
            const keys = [...app._rateBuckets.keys()];
            assert.strictEqual(keys.length, 1);
            assert.match(keys[0], /^[0-9a-f]{64}$/, 'bucket keys must be hashes');
            for (const k of keys)
                assert.ok(!k.includes('super-secret-token'), 'a raw credential must never be a map key');
        });
    });

    it('prunes expired buckets so the map cannot grow without bound', async () => {
        const app = buildApp(5, 20);
        await withServer(app, async (send) => {
            await send({ authorization: 'Bearer k1' });
            // The limiter prunes expired buckets on every request (before the limit
            // check), so poll the real effect: keep sending k2 until k1's window has
            // lapsed and the prune drops it, rather than sleeping a fixed span.
            await waitFor(async () => {
                await send({ authorization: 'Bearer k2' });
                return app._rateBuckets.size === 1;
            }, { message: 'the expired k1 bucket must be pruned once its window passes' });
            assert.strictEqual(app._rateBuckets.size, 1, 'the expired k1 bucket must be gone');
        });
    });

    it('an explicit 0 disables the limiter and nothing else does', async () => {
        const app = buildApp(0, 60000);
        await withServer(app, async (send) => {
            for (let i = 0; i < 5; i++)
                assert.strictEqual((await send()).status, 200);
            assert.strictEqual(app._rateBuckets.size, 0, 'a disabled limiter must not accumulate buckets');
        });
    });

    it('falls back to safe defaults on a junk env value', () => {
        assert.strictEqual(resolveRateLimit({}), 300);
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: 'plenty' }), 300);
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: '-1' }), 300);
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: '0' }), 0);   // the one off switch
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: '25' }), 25);
        assert.strictEqual(resolveRateWindowMs({}), 60000);
        assert.strictEqual(resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: 'soon' }), 60000);
        assert.strictEqual(resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: '0' }), 60000);
        assert.strictEqual(resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: '1000' }), 1000);
    });

    it('src/api.js mounts the limiter BEFORE the auth gate and the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const rateIdx   = src.indexOf('app.use(rateLimitMiddleware(');
        const authIdx   = src.indexOf('safeTokenEqual(got, SDK_API_KEY)');
        const routerIdx = src.indexOf('jsonRouter(');
        assert.notStrictEqual(rateIdx, -1, 'rate limiter not mounted in src/api.js');
        assert.ok(rateIdx < authIdx, 'the limiter must run before the auth gate so anonymous floods are bounded');
        assert.ok(rateIdx < routerIdx, 'the limiter must run before the router');
    });

    it('keeps ONE implementation of the limiter: api.js holds no inline copy', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        assert.ok(!/rateBuckets/.test(src),
            'src/api.js re-implements the limiter inline; it must mount rateLimitMiddleware instead');
    });

    it('adds no runtime dependency for the limiter', () => {
        const pkg = require('../../package.json');
        const deps = Object.keys(pkg.dependencies || {});
        for (const forbidden of ['express-rate-limit', 'rate-limiter-flexible', 'express-slow-down'])
            assert.ok(!deps.includes(forbidden), forbidden + ' must not be a runtime dependency of a published SDK');
    });
});
