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
const { SDKError, SDKRateLimitedError } = require('../../../../src/utils/errors.js');

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

        it('429 then 200: the retry is honoured and the caller sees nothing', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .get('/BTC/api/status').reply(200, { ok: true });

            const result = await makeClient().getStatus();
            expect(result).to.deep.equal({ ok: true });
        });

        it('429 then 429: throws SDKRateLimitedError carrying the seconds', async function () {
            nock(EXPLORER_BASE)
                .get('/BTC/api/status').reply(429, { error: 'slow down' }, { 'Retry-After': '30' })
                .get('/BTC/api/status').reply(429, { error: 'slow down' }, { 'Retry-After': '30' });

            let thrown;
            try {
                await makeClient().getStatus();
            } catch (e) { thrown = e; }

            expect(thrown).to.exist;
            expect(thrown.name).to.equal('SDKRateLimitedError');
            expect(thrown).to.be.instanceof(SDKRateLimitedError);
            expect(thrown).to.be.instanceof(SDKError);
            expect(thrown.code).to.equal('RATE_LIMITED');
            expect(thrown.service).to.equal('explorer');
            expect(thrown.status).to.equal(429);
            expect(thrown.retryAfterSeconds).to.equal(30);
            expect(thrown.message).to.equal('Explorer returned HTTP 429 for /BTC/api/status; retry after 30 seconds');
            expect(thrown.details.url).to.equal('/BTC/api/status');
            expect(thrown.details.data).to.deep.equal({ error: 'slow down' });
        });

    });

});
