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
const {
    getRateLimitDelay,
    getRetryAfterSeconds,
    parseRateLimitReset
} = require('../../../../src/utils/retry.js');

function rateLimitErr(headers, status = 429) {
    return { response: { status, headers, data: { error: 'rate limited' } } };
}

describe('retry: the 429 path', function () {

    describe('parseRateLimitReset() / getRateLimitDelay() / getRetryAfterSeconds()', function () {

        it('parseRateLimitReset turns whole seconds into milliseconds', function () {
            expect(parseRateLimitReset('45')).to.equal(45000);
            expect(parseRateLimitReset('0')).to.equal(0);
        });

        it('parseRateLimitReset returns null for absent or unparseable values', function () {
            expect(parseRateLimitReset(undefined)).to.equal(null);
            expect(parseRateLimitReset('')).to.equal(null);
            expect(parseRateLimitReset('soon')).to.equal(null);
            expect(parseRateLimitReset('-5')).to.equal(null);
        });

        it('getRateLimitDelay returns null when neither header is present', function () {
            expect(getRateLimitDelay(rateLimitErr({}))).to.equal(null);
            expect(getRateLimitDelay(null)).to.equal(null);
        });

        it('getRetryAfterSeconds reads whole seconds off either header', function () {
            expect(getRetryAfterSeconds(rateLimitErr({ 'retry-after': '30' }))).to.equal(30);
            expect(getRetryAfterSeconds(rateLimitErr({ 'ratelimit-reset': '45' }))).to.equal(45);
        });

        it('getRetryAfterSeconds rounds UP, since waiting short buys another 429', function () {
            // An origin's HTTP-date lands on a whole second, our clock does not,
            // so the delta is fractional. Freeze the clock 1.4 s short of the
            // date: rounding DOWN would send the retry back before the window
            // reopened. Frozen rather than sampled, or the sub-second phase of
            // the real clock decides whether this test passes.
            const realNow = Date.now;
            const when    = 'Fri, 01 Jan 2100 00:00:02 GMT';
            Date.now = () => Date.parse(when) - 1400;
            try {
                expect(getRetryAfterSeconds(rateLimitErr({ 'retry-after': when }))).to.equal(2);
            } finally {
                Date.now = realNow;
            }
        });

        it('getRetryAfterSeconds returns null when the response asked for nothing', function () {
            expect(getRetryAfterSeconds(rateLimitErr({}))).to.equal(null);
        });

    });

});
