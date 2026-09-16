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
const nock = require('nock');
const ExplorerClient = require('../../../../src/clients/explorer.js');

describe('retry: the 429 path', function () {

    describe('(e) ExplorerClient on a surviving 429', function () {

        const EXPLORER_BASE = 'http://ratelimit.test:8080';

        function makeClient() {
            // retryAfterMaxDelay: 20 keeps the honoured wait at 20 ms in-test
            // while the header still says 30 s, so the reported seconds and the
            // cap are exercised independently.
            return new ExplorerClient({
                network:      'bitcoin-mainnet',
                explorerUrl:  'ratelimit.test',
                explorerPort: 8080,
                retry: { maxRetries: 2, baseDelay: 10, retryAfterMaxDelay: 20 }
            });
        }

        afterEach(() => nock.cleanAll());

        it('429 with RateLimit-Reset only: the seconds come off the fallback header', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, {}, { 'RateLimit-Reset': '45' })
                .get('/BTC/api/status').reply(429, {}, { 'RateLimit-Reset': '45' });

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown.retryAfterSeconds).to.equal(45);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/status; retry after 45 seconds');
        });

        it('429 with no wait header: the message omits the suffix and the field is null', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, {})
                .get('/BTC/api/status').reply(429, {});

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown.retryAfterSeconds).to.equal(null);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/status');
        });

    });

});
