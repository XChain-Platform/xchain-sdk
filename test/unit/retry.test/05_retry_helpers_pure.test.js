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
    DEFAULTS,
    getDelay,
    getRetryAfterDelay,
    parseRetryAfter
} = require('../../../src/utils/retry.js');

function registerParseRetryAfterTests() {
    describe('parseRetryAfter', function () {
        it('returns null for falsy input', function () {
            expect(parseRetryAfter(null)).to.equal(null);
            expect(parseRetryAfter('')).to.equal(null);
            expect(parseRetryAfter(undefined)).to.equal(null);
        });

        it('parses integer seconds to milliseconds', function () {
            expect(parseRetryAfter('120')).to.equal(120000);
            expect(parseRetryAfter('0')).to.equal(0);
        });

        it('parses an HTTP-date to a non-negative delay', function () {
            const ms = parseRetryAfter('Fri, 01 Jan 2100 00:00:00 GMT');
            expect(ms).to.be.a('number');
            expect(ms).to.be.greaterThan(0);
        });

        it('clamps a past HTTP-date to 0', function () {
            const ms = parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT');
            expect(ms).to.equal(0);
        });

        it('returns null for an unparseable value', function () {
            expect(parseRetryAfter('not-a-date-or-number')).to.equal(null);
        });
    });
}

function registerRetryAfterDelayTests() {
    describe('getRetryAfterDelay', function () {
        it('returns null when the error has no response/headers', function () {
            expect(getRetryAfterDelay(null)).to.equal(null);
            expect(getRetryAfterDelay({})).to.equal(null);
            expect(getRetryAfterDelay({ response: {} })).to.equal(null);
        });

        it('extracts the Retry-After header from an axios-style error', function () {
            const err = { response: { headers: { 'retry-after': '30' } } };
            expect(getRetryAfterDelay(err)).to.equal(30000);
        });
    });
}

function registerDelayTests() {
    describe('getDelay', function () {
        it('honours a Retry-After header, capped at maxDelay', function () {
            const cfg = { ...DEFAULTS, maxDelay: 5000 };
            const err = { response: { headers: { 'retry-after': '30' } } }; // 30000 > cap
            expect(getDelay(0, cfg, err)).to.equal(5000);
        });

        it('falls back to exponential backoff (+/- jitter) without a Retry-After', function () {
            const cfg = { baseDelay: 100, backoffFactor: 2, maxDelay: 100000 };
            // attempt 3 → base*2^3 = 800, ±25% jitter → within [600, 1000]
            const d = getDelay(3, cfg, new Error('net'));
            expect(d).to.be.greaterThan(599);
            expect(d).to.be.lessThan(1001);
        });

        it('caps exponential backoff at maxDelay (jitter is applied after the cap)', function () {
            const cfg = { baseDelay: 1000, backoffFactor: 10, maxDelay: 2000 };
            const d = getDelay(5, cfg, new Error('net')); // huge → capped to 2000, then ±25% jitter
            // The cap is applied BEFORE the ±25% jitter, so the final value lands in
            // [maxDelay*0.75, maxDelay*1.25] = [1500, 2500], never the un-capped huge value.
            expect(d).to.be.at.least(1500);
            expect(d).to.be.at.most(2500);
        });
    });
}

// Pure retry helpers (parseRetryAfter / getRetryAfterDelay / getDelay) ──

describe('retry helpers (pure)', function () {
    registerParseRetryAfterTests();
    registerRetryAfterDelayTests();
    registerDelayTests();
});
