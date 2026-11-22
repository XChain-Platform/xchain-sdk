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
 * XChain Platform SDK - API request-rate window and many-address flood tests
 *
 * The window setting is read at module load, so its fallbacks are checked in a
 * fresh node; the anonymous-bucket cap is driven through the shipped middleware
 * with stubbed requests, since every HTTP test arrives from 127.0.0.1.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const os     = require('os');
const { execFile } = require('child_process');
const {
    rateLimitMiddleware,
    resolveRateWindowMs
} = require('../../../src/utils/api_guards.js');
const { waitFor } = require('../../helpers/wait.js');
const { KNOWN_KEYS, buildApp, withServer } = require('./helpers/rate_limit_app.js');

// Loads src/api/index.js in a fresh node with one window setting and returns its stderr,
// where the module-load warnings land (the logger's default sink is console.warn).
function loadApiStderr(windowMs) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, NETWORK: 'bitcoin-regtest',
        SDK_API_KEY: 'window-test-key', SDK_API_RATE_WINDOW_MS: windowMs };
    const script = 'require(' + JSON.stringify(path.join(__dirname, '../../../src/api/index.js')) + ');';
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', script], { env, cwd: os.tmpdir(), timeout: 8000 },
            (err, stdout, stderr) => err ? reject(new Error(err.message + '\n' + stderr)) : resolve(stderr));
    });
}

describe('API request-rate window', function () {
    this.timeout(15000);

    it('a truncatable junk window falls back to the default instead of shrinking to milliseconds', () => {
        // parseInt() read '1e5' as 1 and '60s' as 60, a window so short every request
        // opened a fresh bucket, so the limiter in front of the auth gate never fired.
        for (const junk of ['1e5', '1.5e5', '60s', '2m', '1000ms', '0.5', '-1000', '+1000', '0', '', '   '])
            assert.strictEqual(resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: junk }), 60000,
                'a malformed window must fall back to 60000: ' + JSON.stringify(junk));
        // Whole numbers of milliseconds still parse, padding included.
        assert.strictEqual(resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: ' 30000 ' }), 30000);
        assert.strictEqual(resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: '1000' }), 1000);
    });

    it('the shipped limiter still bites when the window env value was junk', async () => {
        const windowMs = resolveRateWindowMs({ SDK_API_RATE_WINDOW_MS: '1e5' });
        assert.strictEqual(windowMs, 60000);
        const app = buildApp(3, windowMs);
        await withServer(app, async (send) => {
            for (let i = 0; i < 3; i++)
                assert.strictEqual((await send()).status, 200, 'request ' + i + ' must be allowed');
            assert.strictEqual((await send()).status, 429, 'request 4 must be rejected inside the window');
        });
    });

    it('warns at load when the window setting was unusable, and stays quiet on a good one', async () => {
        assert.match(await loadApiStderr('60s'), /SDK_API_RATE_WINDOW_MS is not a positive whole number/);
        assert.match(await loadApiStderr('0'), /SDK_API_RATE_WINDOW_MS is not a positive whole number/);
        assert.doesNotMatch(await loadApiStderr('30000'), /SDK_API_RATE_WINDOW_MS/);
    });
});

// Drive the shipped middleware directly, since every HTTP test above arrives from 127.0.0.1
function stubCall(mw, { ip, authorization } = {}) {
    const res = { statusCode: 200, headers: {}, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.json = (body) => { res.body = body; return res; };
    let passed = false;
    const headers = authorization ? { authorization } : {};
    mw({ headers, ip }, res, () => { passed = true; });
    return { passed, res };
}

describe('API request-rate limit under a many-address flood', function () {
    this.timeout(10000);

    it('caps anonymous buckets and refuses a new address at the cap with 429', () => {
        const mw = rateLimitMiddleware({ limit: 5, windowMs: 60000, isCredential: KNOWN_KEYS, maxAnonBuckets: 3 });
        for (let i = 0; i < 3; i++)
            assert.strictEqual(stubCall(mw, { ip: '10.0.0.' + i }).passed, true, 'address ' + i + ' must pass');
        const refused = stubCall(mw, { ip: '10.0.0.99' });
        assert.strictEqual(refused.passed, false, 'a new address past the cap must not reach next()');
        assert.strictEqual(refused.res.statusCode, 429);
        assert.strictEqual(refused.res.body.error.code, -32005);
        assert.ok(Number(refused.res.headers['Retry-After']) >= 1, 'Retry-After must be a positive number of seconds');
        assert.strictEqual(mw.buckets.size, 3, 'a refused address must not mint a bucket');
    });

    it('still serves an address that already holds a bucket when the cap is reached', () => {
        const mw = rateLimitMiddleware({ limit: 5, windowMs: 60000, isCredential: KNOWN_KEYS, maxAnonBuckets: 2 });
        stubCall(mw, { ip: '10.0.0.1' });
        stubCall(mw, { ip: '10.0.0.2' });
        assert.strictEqual(stubCall(mw, { ip: '10.0.0.1' }).passed, true);
    });

    it('never refuses a credential bucket because of the anonymous cap', () => {
        const mw = rateLimitMiddleware({ limit: 5, windowMs: 60000, isCredential: KNOWN_KEYS, maxAnonBuckets: 2 });
        stubCall(mw, { ip: '10.0.0.1' });
        stubCall(mw, { ip: '10.0.0.2' });
        assert.strictEqual(stubCall(mw, { ip: '10.0.0.3' }).passed, false, 'the cap must bite for a new anonymous address');
        assert.strictEqual(stubCall(mw, { ip: '10.0.0.3', authorization: 'Bearer key-a' }).passed, true,
            'the real key holder must pass while the anonymous cap is full');
        assert.strictEqual(mw.buckets.size, 3);
    });

    it('gives cap slots back once anonymous buckets expire', async () => {
        const mw = rateLimitMiddleware({ limit: 5, windowMs: 20, isCredential: KNOWN_KEYS, maxAnonBuckets: 2 });
        stubCall(mw, { ip: '10.0.0.1' });
        stubCall(mw, { ip: '10.0.0.2' });
        assert.strictEqual(stubCall(mw, { ip: '10.0.0.3' }).passed, false);
        // The two buckets can be stamped a millisecond apart, so probe only after BOTH expire;
        // a probe between the two expiries is admitted with the later bucket still live
        const expiredAt = Math.max(...[...mw.buckets.values()].map((b) => b.resetAt));
        await waitFor(() => Date.now() > expiredAt, { message: 'the earlier buckets must expire' });
        assert.strictEqual(stubCall(mw, { ip: '10.0.0.3' }).passed, true,
            'a new address must be admitted once the earlier buckets expire');
        assert.strictEqual(mw.buckets.size, 1, 'the expired buckets must be pruned, leaving only the fresh one');
    });

    it('prunes from the front and stops at the first live bucket', async () => {
        const mw = rateLimitMiddleware({ limit: 5, windowMs: 20, isCredential: KNOWN_KEYS });
        for (let i = 0; i < 5; i++) stubCall(mw, { ip: '10.0.1.' + i });
        const expiredAt = Math.max(...[...mw.buckets.values()].map((b) => b.resetAt));
        await waitFor(() => Date.now() > expiredAt, { message: 'the first five buckets must expire' });
        stubCall(mw, { ip: '10.0.2.1' });
        assert.strictEqual(mw.buckets.size, 1, 'every expired bucket ahead of the fresh one must be gone');
        const fresh = [...mw.buckets.values()][0];
        assert.ok(fresh.resetAt > Date.now() - 1, 'the survivor must be the fresh bucket');
    });
});
