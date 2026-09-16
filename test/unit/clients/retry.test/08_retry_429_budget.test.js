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
const { withRetry } = require('../../../../src/utils/retry.js');

describe('retry: the 429 path', function () {

    describe('withRetry() 429 budget', function () {

        it('(d) maxRateLimitRetries: 1 with maxRetries: 3 throws on the second 429', async function () {
            let callCount = 0;
            const err429 = { response: { status: 429, headers: {} }, message: 'too many requests' };

            let thrown;
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err429;
                }, { maxRetries: 3, baseDelay: 10, maxRateLimitRetries: 1 });
            } catch (e) {
                thrown = e;
            }
            expect(thrown).to.equal(err429);
            // One honoured retry, then the caller gets the rate limit, even
            // though maxRetries would have allowed three attempts more.
            expect(callCount).to.equal(2);
        });

        it('maxRateLimitRetries: 0 throws the first 429 without retrying', async function () {
            let callCount = 0;
            const err429 = { response: { status: 429, headers: {} }, message: 'too many requests' };
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err429;
                }, { maxRetries: 3, baseDelay: 10, maxRateLimitRetries: 0 });
            } catch (e) { /* expected */ }
            expect(callCount).to.equal(1);
        });

        it('the 429 budget does not shrink the 5xx budget', async function () {
            let callCount = 0;
            const err503 = { response: { status: 503, headers: {} }, message: 'unavailable' };
            try {
                await withRetry(async () => {
                    callCount++;
                    throw err503;
                }, { maxRetries: 3, baseDelay: 10, maxRateLimitRetries: 1 });
            } catch (e) { /* expected */ }
            expect(callCount).to.equal(4);
        });

    });

});
