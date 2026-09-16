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
 * XChain Platform SDK - Retry Logic & Request Hooks Tests
 *
 ********************************************************************/

const { expect } = require('chai');
const { DEFAULTS, getDelay } = require('../../../../src/utils/retry.js');


// The 429 path (rate limits)
//
// A rate limit is a policy answer with a wait attached, so it is budgeted and
// capped apart from 5xx backoff: retryAfterMaxDelay caps the honoured wait
// (maxDelay does not), maxRateLimitRetries caps how many 429s are retried, and
// a 429 that survives the retry reaches the caller as SDKRateLimitedError.

function rateLimitErr(headers, status = 429) {
    return { response: { status, headers, data: { error: 'rate limited' } } };
}

describe('retry: the 429 path', function () {

    describe('DEFAULTS', function () {
        it('caps an honoured Retry-After at 60 s and retries a 429 once', function () {
            expect(DEFAULTS.retryAfterMaxDelay).to.equal(60000);
            expect(DEFAULTS.maxRateLimitRetries).to.equal(1);
        });
    });

});

describe('retry: the 429 path', function () {

    describe('getDelay() on a 429', function () {

        it('(a) honours Retry-After: 30 past a maxDelay of 2000', function () {
            // The wallet ships maxDelay: 2000 to keep 5xx backoff short. That
            // must not shrink the wait a rate limiter actually asked for.
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '30' }))).to.equal(30000);
        });

        it('(b) a 503 with Retry-After: 30 still clamps to maxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '30' }, 503))).to.equal(2000);
        });

        it('caps an absurd Retry-After at retryAfterMaxDelay, not maxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000, retryAfterMaxDelay: 60000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '900' }))).to.equal(60000);
        });

        it('honours an overridden retryAfterMaxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000, retryAfterMaxDelay: 5000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '30' }))).to.equal(5000);
        });

        it('(c) falls back to RateLimit-Reset when Retry-After is absent', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'ratelimit-reset': '45' }))).to.equal(45000);
        });

        it('prefers Retry-After over RateLimit-Reset when both are present', function () {
            const cfg = { ...DEFAULTS, maxDelay: 2000 };
            expect(getDelay(0, cfg, rateLimitErr({ 'retry-after': '10', 'ratelimit-reset': '45' }))).to.equal(10000);
        });

        it('falls back to normal backoff for a 429 carrying neither header', function () {
            const cfg = { baseDelay: 100, backoffFactor: 2, maxDelay: 2000, retryAfterMaxDelay: 60000 };
            const d = getDelay(3, cfg, rateLimitErr({}));
            // base*2^3 = 800, ±25% jitter, and nowhere near the 60 s ceiling
            expect(d).to.be.greaterThan(599);
            expect(d).to.be.lessThan(1001);
        });

    });

});
