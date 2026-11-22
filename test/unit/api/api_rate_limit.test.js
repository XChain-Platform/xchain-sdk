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
 * These tests mount the SHIPPED limiter from src/utils/api_guards.js (the same
 * function src/api/index.js mounts) rather than a copy of it, so the limiter is
 * driven alone, without the SDK or the other guards in front of it, and a
 * built-app check pins that api.js mounts it ahead of the auth gate and the
 * router. (src/api/index.js used to start a live server at require time; it now
 * exports createApp and startApi and listens only as the CLI entry.)
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execFile } = require('child_process');
const {
    rateLimitMiddleware,
    resolveRateLimit,
    resolveRateWindowMs
} = require('../../../src/utils/api_guards.js');
const { waitFor } = require('../../helpers/wait.js');
const { mountIndexes, DISPATCH_NAME } = require('./helpers/mount_order.js');
const { KNOWN_KEYS, buildApp, withServer } = require('./helpers/rate_limit_app.js');

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

    it('an unvalidated token does not mint its own bucket: a rotating junk token is capped per source address', async () => {
        const app = buildApp(2, 60000);
        await withServer(app, async (send) => {
            assert.strictEqual((await send({ authorization: 'Bearer junk-1' })).status, 200);
            assert.strictEqual((await send({ authorization: 'Bearer junk-2' })).status, 200);
            assert.strictEqual((await send({ authorization: 'Bearer junk-3' })).status, 429,
                'a fresh random token per request must not escape the cap');
            assert.strictEqual((await send()).status, 429, 'junk tokens share the bare-address bucket');
            assert.strictEqual(app._rateBuckets.size, 1, 'rotating junk tokens must not grow the map');
            // The configured credential still has its own budget.
            assert.strictEqual((await send({ authorization: 'Bearer key-a' })).status, 200);
        });
    });

    it('with no isCredential predicate every caller is bucketed by source address', async () => {
        const app = buildApp(1, 60000, null);           // null, not undefined: bypass the default arg
        await withServer(app, async (send) => {
            assert.strictEqual((await send({ authorization: 'Bearer key-a' })).status, 200);
            assert.strictEqual((await send({ authorization: 'Bearer key-b' })).status, 429);
        });
    });
});

describe('API request-rate limit', function () {
    this.timeout(10000);

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
});

describe('API request-rate limit', function () {
    this.timeout(10000);

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

    it('a zero-prefixed junk value is junk, not the off switch', () => {
        // parseInt() truncates at the first non-digit, so a zero-prefixed junk value
        // resolves to 0/-0 and reaches the limiter's "0 disables" branch, turning an
        // operator typo into a disabled limiter. The whole string is validated instead.
        for (const junk of ['0junk', '0.5', '-0.5', '0x10', '1e3', '00 1', '+0', '', '   '])
            assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: junk }), 300,
                'a malformed value must fall back to 300, not disable the limiter: ' + JSON.stringify(junk));
        // Whole numbers still parse, padding included, and 0 is still the one off switch.
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: ' 300 ' }), 300);
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: '007' }), 7);
        assert.strictEqual(resolveRateLimit({ SDK_API_RATE_LIMIT: '0' }), 0);
    });

    it('the shipped limiter still bites when the env value was junk', async () => {
        // The end-to-end form of the assertion above, on the real middleware:
        // with the truncating parse this app ran unlimited and every one of the
        // 301 requests returned 200.
        const limit = resolveRateLimit({ SDK_API_RATE_LIMIT: '0junk' });
        assert.strictEqual(limit, 300);
        const app = buildApp(limit, 60000);
        await withServer(app, async (send) => {
            for (let i = 0; i < limit; i++)
                assert.strictEqual((await send()).status, 200, 'request ' + i + ' must be allowed');
            assert.strictEqual((await send()).status, 429, 'request 301 must be rejected, not waved through');
        });
    });
});

describe('API request-rate limit', function () {
    this.timeout(10000);

    it('src/api.js mounts the limiter BEFORE the auth gate and the jsonRouter mount', () => {
        // Read from the BUILT app, so a mount moved into a helper is placed by its call site.
        const at = mountIndexes(assert, ['rateLimit', 'authGate', DISPATCH_NAME]);
        assert.ok(at.rateLimit < at.authGate, 'the limiter must run before the auth gate so anonymous floods are bounded');
        assert.ok(at.rateLimit < at[DISPATCH_NAME], 'the limiter must run before the router');
    });

    it('mounts the limiter ahead of the body parser and the batch cap, which refuse requests themselves', () => {
        const at = mountIndexes(assert, ['rateLimit', 'jsonParser', 'batchCap']);
        assert.ok(at.rateLimit < at.jsonParser, 'a malformed-JSON refusal must already have spent the caller\'s budget');
        assert.ok(at.rateLimit < at.batchCap, 'an over-cap batch refusal must already have spent the caller\'s budget');
    });

    it('answers 429 to requests the body parser and the batch cap refuse once the budget is spent', async () => {
        const script = [
            "const http = require('http');",
            'const { createApp } = require(' + JSON.stringify(path.join(__dirname, '../../../src/api/index.js')) + ');',
            'const app = createApp({});',
            "const s = app.listen(0, '127.0.0.1', async () => {",
            '  const send = (b) => new Promise((r) => {',
            "    const q = http.request({ host: '127.0.0.1', port: s.address().port, method: 'POST',",
            "      headers: { 'content-type': 'application/json' } }, (x) => { x.resume(); x.on('end', () => r(x.statusCode)); });",
            '    q.end(b); });',
            '  const bad = [], batch = [];',
            "  for (let i = 0; i < 10; i++) bad.push(await send('{\"method\":'));",
            '  const big = JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })));',
            '  for (let i = 0; i < 3; i++) batch.push(await send(big));',
            '  process.stdout.write(JSON.stringify({ bad, batch }));',
            '  s.close(); process.exit(0); });'
        ].join('\n');
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, NETWORK: 'bitcoin-regtest',
            SDK_API_KEY: 'prelimiter-test-key', SDK_API_RATE_LIMIT: '5', SDK_API_RATE_WINDOW_MS: '60000' };
        const out = await new Promise((resolve, reject) => {
            execFile(process.execPath, ['-e', script], { env, cwd: os.tmpdir(), timeout: 8000 },
                (err, stdout, stderr) => err ? reject(new Error(err.message + '\n' + stderr)) : resolve(stdout));
        });
        const r = JSON.parse(out);
        assert.deepStrictEqual(r.bad, [400, 400, 400, 400, 400, 429, 429, 429, 429, 429]);
        assert.deepStrictEqual(r.batch, [429, 429, 429], 'an over-cap batch past the limit must be throttled, not refused with a 400');
    });

    it('keeps ONE implementation of the limiter: api.js holds no inline copy', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../../src/api/index.js'), 'utf8');
        assert.ok(!/rateBuckets/.test(src),
            'src/api.js re-implements the limiter inline; it must mount rateLimitMiddleware instead');
    });

    it('adds no runtime dependency for the limiter', () => {
        const pkg = require('../../../package.json');
        const deps = Object.keys(pkg.dependencies || {});
        for (const forbidden of ['express-rate-limit', 'rate-limiter-flexible', 'express-slow-down'])
            assert.ok(!deps.includes(forbidden), forbidden + ' must not be a runtime dependency of a published SDK');
    });
});
