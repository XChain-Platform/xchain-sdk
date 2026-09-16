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
const { withRetry, isRetryable, getDelay } = require('../../../src/utils/retry.js');


function registerIsRetryableTests() {
    // isRetryable
    describe('isRetryable()', () => {
        it('returns true for HTTP 429', () => {
            expect(isRetryable({ response: { status: 429 } })).to.equal(true);
        });

        it('returns true for HTTP 502', () => {
            expect(isRetryable({ response: { status: 502 } })).to.equal(true);
        });

        it('returns true for HTTP 503', () => {
            expect(isRetryable({ response: { status: 503 } })).to.equal(true);
        });

        it('returns true for HTTP 504', () => {
            expect(isRetryable({ response: { status: 504 } })).to.equal(true);
        });

        it('returns false for HTTP 400', () => {
            expect(isRetryable({ response: { status: 400 } })).to.equal(false);
        });

        it('returns false for HTTP 404', () => {
            expect(isRetryable({ response: { status: 404 } })).to.equal(false);
        });

        it('returns true for ECONNABORTED (timeout)', () => {
            expect(isRetryable({ code: 'ECONNABORTED' })).to.equal(true);
        });

        it('returns true for ECONNRESET', () => {
            expect(isRetryable({ code: 'ECONNRESET' })).to.equal(true);
        });

        it('returns false for error with no response and no code', () => {
            expect(isRetryable({})).to.equal(false);
        });
    });
}

function registerDelayTests() {
    // getDelay
    describe('getDelay()', () => {
        it('returns a number > 0 for attempt 0', () => {
            let config = { baseDelay: 100, maxDelay: 30000, backoffFactor: 2 };
            let delay = getDelay(0, config);
            expect(delay).to.be.a('number').and.to.be.at.least(0);
            // With 25% jitter the minimum possible is 100 * 1 * 0.75 = 75, but
            // Math.max(0,...) is used so just verify it is non-negative and > 0 on average.
            // Use a looser check: delay should be > 0 (statistically always true for baseDelay=100)
            expect(delay).to.be.greaterThan(0);
        });

        it('increases with attempt number (attempt 1 < attempt 3 on average)', () => {
            let config = { baseDelay: 100, maxDelay: 30000, backoffFactor: 2 };
            // Run several samples and compare medians to reduce jitter noise
            let sum1 = 0, sum3 = 0, samples = 20;
            for (let i = 0; i < samples; i++) {
                sum1 += getDelay(1, config);
                sum3 += getDelay(3, config);
            }
            expect(sum3 / samples).to.be.greaterThan(sum1 / samples);
        });

        it('never exceeds maxDelay + 25% jitter', () => {
            // getDelay clamps to maxDelay before adding ±25% jitter, so the
            // observable ceiling is maxDelay * 1.25. Verify we never exceed it.
            let config = { baseDelay: 1000, maxDelay: 5000, backoffFactor: 2 };
            let ceiling = config.maxDelay * 1.25;
            for (let attempt = 0; attempt < 20; attempt++) {
                expect(getDelay(attempt, config)).to.be.at.most(ceiling);
            }
        });
    });
}

function registerRetrySuccessTests() {
    it('succeeds on first try: fn called exactly once', async () => {
        let callCount = 0;
        let result = await withRetry(async () => {
            callCount++;
            return 'ok';
        }, { maxRetries: 2, baseDelay: 10 });
        expect(result).to.equal('ok');
        expect(callCount).to.equal(1);
    });

    it('fails once then succeeds: fn called exactly twice', async () => {
        let callCount = 0;
        let result = await withRetry(async () => {
            callCount++;
            if (callCount === 1) {
                let err = new Error('transient');
                err.response = { status: 503 };
                throw err;
            }
            return 'recovered';
        }, { maxRetries: 2, baseDelay: 10 });
        expect(result).to.equal('recovered');
        expect(callCount).to.equal(2);
    });
}

function registerRetryFailureTests() {
    it('fails with non-retryable error: throws immediately, fn called once', async () => {
        let callCount = 0;
        let err400 = new Error('bad request');
        err400.response = { status: 400 };

        let thrown;
        try {
            await withRetry(async () => {
                callCount++;
                throw err400;
            }, { maxRetries: 2, baseDelay: 10 });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.equal(err400);
        expect(callCount).to.equal(1);
    });

    it('exhausts all retries: throws last error', async () => {
        let callCount = 0;
        let transient = new Error('service unavailable');
        transient.response = { status: 503 };

        let thrown;
        try {
            await withRetry(async () => {
                callCount++;
                throw transient;
            }, { maxRetries: 2, baseDelay: 10 });
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.equal(transient);
        // 1 initial + 2 retries = 3 total
        expect(callCount).to.equal(3);
    });
}

function registerWithRetryTests() {
    // withRetry
    describe('withRetry()', () => {
        registerRetrySuccessTests();
        registerRetryFailureTests();
    });
}


// Retry utility unit tests

describe('retry utility', () => {
    registerIsRetryableTests();
    registerDelayTests();
    registerWithRetryTests();

});
